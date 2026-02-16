#!/usr/bin/env bash
set -euo pipefail

COL="testing/postman/Wellsite-Phase3.postman_collection.json"
ENV="testing/postman/Wellsite-Phase3.local.postman_environment.json"

newman run "$COL" -e "$ENV" --reporters cli,junit --reporter-junit-export testing/postman/newman-phase3.xml
