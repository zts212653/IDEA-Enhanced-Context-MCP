# IDEA PSI Exporter

Minimal IntelliJ Platform plugin that traverses PSI, serializes symbol metadata and uploads batches to the IDEA-Enhanced-Context bridge.

## How to build/run

```bash
cd idea-psi-exporter
./gradlew build
./gradlew runIde
```

Inside the IDE, use **Tools → Export PSI to Bridge** to run the action. It collects Java classes, builds `SymbolRecord` payloads, chunks them (500 per batch) and POSTs to `IDEA_BRIDGE_URL` (default `http://127.0.0.1:63000/api/psi/upload`).
