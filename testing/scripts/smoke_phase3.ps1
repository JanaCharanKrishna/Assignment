$ErrorActionPreference = "Stop"

$col = "testing/postman/Wellsite-Phase3.postman_collection.json"
$env = "testing/postman/Wellsite-Phase3.local.postman_environment.json"

newman run $col -e $env --reporters cli,junit --reporter-junit-export testing/postman/newman-phase3.xml
