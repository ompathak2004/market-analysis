#!/usr/bin/env bash
# Usage: infra/aws/deploy.sh
# Builds the worker image from the current checkout, pushes it as <git sha> and latest, registers a task
# definition revision with that image and rolls the service. Requires docker, aws CLI v2 and jq.
set -euo pipefail

region=${AWS_REGION:-ap-south-1}
cluster=${CLUSTER:-market-analysis}
service=${SERVICE:-market-analysis-worker}
family=${TASK_FAMILY:-market-analysis-worker}
repository=${REPOSITORY:-market-analysis-worker}

for tool in docker aws jq git; do
  command -v "$tool" >/dev/null || { echo "$tool is required" >&2; exit 1; }
done

cd "$(git rev-parse --show-toplevel)"
sha=$(git rev-parse HEAD)
if [[ -n "$(git status --porcelain)" ]]; then
  sha="${sha}-dirty-$(date -u +%Y%m%d%H%M%S)"
  echo "working tree is dirty; tagging as $sha" >&2
fi

account=$(aws sts get-caller-identity --query Account --output text)
registry="${account}.dkr.ecr.${region}.amazonaws.com"
image="${registry}/${repository}"

aws ecr get-login-password --region "$region" | docker login --username AWS --password-stdin "$registry"

docker build --platform linux/amd64 -t "${image}:${sha}" -t "${image}:latest" .
docker push "${image}:${sha}"
docker push "${image}:latest"

current=$(aws ecs describe-task-definition --region "$region" --task-definition "$family" --query taskDefinition --output json)
rendered=$(jq --arg image "${image}:${sha}" '
  .containerDefinitions |= map(if .name == "worker" then .image = $image else . end)
  | del(.taskDefinitionArn, .revision, .status, .requiresAttributes, .compatibilities,
        .registeredAt, .registeredBy, .deregisteredAt)' <<<"$current")
revision=$(aws ecs register-task-definition --region "$region" --cli-input-json "$rendered" \
  --query taskDefinition.taskDefinitionArn --output text)
echo "registered $revision"

aws ecs update-service --region "$region" --cluster "$cluster" --service "$service" \
  --task-definition "$revision" --force-new-deployment --query service.deployments[0].id --output text
echo "waiting for $service to become stable"
aws ecs wait services-stable --region "$region" --cluster "$cluster" --services "$service"
echo "deployed ${image}:${sha}"
