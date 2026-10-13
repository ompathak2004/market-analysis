#!/usr/bin/env bash
# Usage: infra/aws/ssm-parameters.sh <env-file> [environment]
# Writes every NAME=value line of <env-file> to SSM as SecureString /market-analysis/<environment>/NAME.
# Values are passed to the AWS CLI through a temporary JSON file, never on the command line or stdout.
set -euo pipefail

env_file=${1:?usage: ssm-parameters.sh <env-file> [environment]}
environment=${2:-prod}
region=${AWS_REGION:-ap-south-1}
prefix="/market-analysis/${environment}"

# Local-only variables that must not reach the worker.
skip_re='^(NODE_ENV|LOG_LEVEL|NEXT_ALLOWED_DEV_ORIGINS|NEXT_PUBLIC_.*)$'

[[ -r "$env_file" ]] || { echo "cannot read $env_file" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 is required" >&2; exit 1; }

tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
chmod 600 "$tmp"

written=0
skipped=0
while IFS= read -r line || [[ -n "$line" ]]; do
  line=${line%$'\r'}
  [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
  line=${line#export }
  [[ "$line" == *=* ]] || continue
  name=${line%%=*}
  name=${name//[[:space:]]/}
  value=${line#*=}
  if [[ ! "$name" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
    echo "skip   invalid name" >&2
    continue
  fi
  if [[ "$name" =~ $skip_re ]]; then
    echo "skip   $name (local only)"
    skipped=$((skipped + 1))
    continue
  fi
  if [[ "$value" =~ ^\"(.*)\"$ || "$value" =~ ^\'(.*)\'$ ]]; then
    value=${BASH_REMATCH[1]}
  fi
  if [[ -z "$value" ]]; then
    # SSM rejects empty values; a single space keeps the ECS secret reference resolvable and the app treats it as unset after trim.
    value=" "
  fi
  NAME="$prefix/$name" VALUE="$value" python3 -c '
import json, os, sys
json.dump({"Name": os.environ["NAME"], "Value": os.environ["VALUE"], "Type": "SecureString", "Overwrite": True, "Tier": "Standard"}, sys.stdout)
' >"$tmp"
  aws ssm put-parameter --region "$region" --cli-input-json "file://$tmp" --output text --query Version >/dev/null
  echo "write  $prefix/$name"
  written=$((written + 1))
done <"$env_file"

echo "done: $written written, $skipped skipped (region $region)"

# The task fails to start if any secret it references is missing, so report gaps against worker.yaml.
template="$(dirname "$0")/worker.yaml"
if [[ -r "$template" ]]; then
  existing=$(aws ssm get-parameters-by-path --region "$region" --path "$prefix" --query 'Parameters[].Name' --output text | tr '\t' '\n')
  missing=0
  while IFS= read -r name; do
    if ! grep -qx "$prefix/$name" <<<"$existing"; then
      echo "missing $prefix/$name (referenced by the task definition)" >&2
      missing=$((missing + 1))
    fi
  done < <(grep -oE 'parameter/market-analysis/[$][{]EnvironmentName[}]/[A-Z0-9_]+' "$template" | sed 's|.*/||' | sort -u)
  [[ $missing -eq 0 ]] || exit 2
fi
