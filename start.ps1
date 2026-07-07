$env:HOST = "0.0.0.0"
if (-not $env:PORT) {
  $env:PORT = "8787"
}
npm start
