# AWS worker infrastructure

The queue worker (`apps/worker`) runs as one ECS Fargate task in `ap-south-1`, account `543588327217`. Everything is plain CloudFormation; there is no CDK toolchain.

| File | What it creates or does |
| --- | --- |
| `ci.yaml` | Stack `market-analysis-ci`: GitHub OIDC provider and role `gha-market-analysis-deploy` (ECR push to one repository, task definition register/describe, update of the one service, `iam:PassRole` on the two task roles, read of `/market-analysis/prod/MIGRATION_DATABASE_URL`). |
| `worker.yaml` | Stack `market-analysis-worker`: ECR repository, log group, archive bucket, SNS topic, ECS cluster/roles/security group/task definition/service, three alarms, monthly budget. |
| `ssm-parameters.sh` | Copies a `.env`-style file into SSM SecureStrings `/market-analysis/prod/<NAME>` without printing values, then lists any secret the task definition needs that is still missing. |
| `deploy.sh` | Manual deploy from a laptop: build, push `<sha>` + `latest`, register a task definition revision with the new image, roll the service, wait for stability. |

CI does the same as `deploy.sh` on every push to `main` that touches the worker, after typecheck, lint, tests and `pnpm db:migrate`. The workflow lives at `infra/aws/github-workflow-worker.yml` because the automation token cannot write under `.github/workflows`; copy it to `.github/workflows/worker.yml` in a commit made with a token that has the `workflow` scope.

## Bootstrap order

Run once with an administrator identity (`aws sts get-caller-identity` should show it; the role names are fixed, so `CAPABILITY_NAMED_IAM` is required).

```bash
export AWS_REGION=ap-south-1

# 1. CI stack. Pass CreateOidcProvider=false if the account already has the GitHub provider.
aws cloudformation deploy --stack-name market-analysis-ci \
  --template-file infra/aws/ci.yaml --capabilities CAPABILITY_NAMED_IAM

# 2. Worker stack with no running task yet (no secrets and no image exist).
vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
subnets=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$vpc Name=map-public-ip-on-launch,Values=true \
  --query 'Subnets[].SubnetId' --output text | tr '\t' ',')
aws cloudformation deploy --stack-name market-analysis-worker \
  --template-file infra/aws/worker.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides AlertEmail=you@example.com VpcId=$vpc SubnetIds=$subnets DesiredCount=0
# Confirm the SNS subscription email, otherwise alarms are silently dropped.

# 3. Secrets. The file holds every variable in .env.example plus RESEND_API_KEY,
#    with DATABASE_URL set to the ma_worker role (see docs/ops.md, Database roles).
#    MIGRATION_DATABASE_URL goes in a second file and is the ma_migrator role, never the admin:
#    run packages/db/roles/bootstrap.sql first so ma_migrator can log in and owns the schema.
infra/aws/ssm-parameters.sh ./.env.aws
infra/aws/ssm-parameters.sh ./.env.migrator

# 4. First image, then start the task.
infra/aws/deploy.sh
aws cloudformation deploy --stack-name market-analysis-worker \
  --template-file infra/aws/worker.yaml --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides DesiredCount=1 ImageTag=$(git rev-parse HEAD)
```

`ssm-parameters.sh` skips `NODE_ENV`, `LOG_LEVEL`, `NEXT_*` (the task definition sets the first two) and the web-only `API_KEY`, `ADMIN_API_KEY` and stores an empty value as a single space, because SSM cannot hold an empty string and the task cannot start if a referenced parameter is missing. It is idempotent (`--overwrite`); rerun it after rotating a value, then `aws ecs update-service --cluster market-analysis --service market-analysis-worker --force-new-deployment`, since secrets are read only when a task starts.

## First-deploy gotchas

- An account that has never used ECS lacks the service-linked role; `CreateCluster` fails with "Unable to assume the service linked role". Run `aws iam create-service-linked-role --aws-service-name ecs.amazonaws.com` once, then redeploy.
- `ArchiveBucket` is retained on stack deletion. If a first create rolls back, delete the empty bucket before retrying, otherwise the next create fails early validation.
- Never set `DesiredCount=1` before an image that starts cleanly is in ECR: the deployment circuit breaker rolls back to a task definition that cannot start either and the stack update hangs until `aws cloudformation cancel-update-stack`.
- Optional task secrets are stored as a single space (SSM rejects empty strings); the config drops blank values before validation, so defaults apply.

## Updating the worker stack

CI registers new task definition revisions outside CloudFormation. Every later stack update must pass the image that is currently deployed, otherwise CloudFormation rolls the service back to the `ImageTag` it last saw:

```bash
current=$(aws ecs describe-services --cluster market-analysis --services market-analysis-worker \
  --query 'services[0].taskDefinition' --output text \
  | xargs aws ecs describe-task-definition --query 'taskDefinition.containerDefinitions[0].image' --output text --task-definition)
aws cloudformation deploy --stack-name market-analysis-worker --template-file infra/aws/worker.yaml \
  --capabilities CAPABILITY_NAMED_IAM --parameter-overrides ImageTag=${current##*:}
```

## Spot or on-demand

The service runs on `FARGATE_SPOT` by default. To switch (for example during a long backfill campaign that should not be interrupted):

```bash
aws cloudformation deploy ... --parameter-overrides UseSpot=false ImageTag=<current sha>
```

The change is an in-place update that starts a new deployment. The same switch without CloudFormation (it will drift until the next stack update):

```bash
aws ecs update-service --cluster market-analysis --service market-analysis-worker \
  --capacity-provider-strategy capacityProvider=FARGATE,weight=1 --force-new-deployment
```

## Exec into the running task

Requires the Session Manager plugin for the AWS CLI and `ecs:ExecuteCommand` on your identity.

```bash
task=$(aws ecs list-tasks --cluster market-analysis --service-name market-analysis-worker --query 'taskArns[0]' --output text)
aws ecs execute-command --cluster market-analysis --task "$task" --container worker --interactive --command "sh"
# inside: node dist/cli.js status
```

## Cost

| Item | Monthly (USD) |
| --- | --- |
| Fargate Spot 0.25 vCPU / 1 GiB, always on (Spot price floats, typically ~70 % below on-demand) | ≈ 3.5–4 |
| Public IPv4 address on the task ($0.005/h) | ≈ 3.6 |
| S3 archive (a few GB) | < 0.5 |
| CloudWatch logs (14 d), custom metrics and three alarms | < 1 |
| ECR (10 images, ~90 MB compressed each) | ≈ 0.1 |
| **Total on Spot** | **≈ 8** (≈ 4.5 if the IPv4 charge is covered by credits or free tier) |
| Same on on-demand Fargate (≈ $12 compute) | ≈ 17 |

The worker is I/O-bound (HTTP, Postgres, LLM calls); 0.25 vCPU is enough for one task. The budget alarm defaults to $15/month.

No NAT gateway and no load balancer: the task gets a public IP in a default-VPC public subnet and the security group allows egress only. Container Insights stays off (the not-running alarm uses the free `AWS/ECS` CPU metric). The budget emails `AlertEmail` at 80 % and 100 % of `MonthlyBudgetUsd` (default 20).
