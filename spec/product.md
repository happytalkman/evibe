# Evide implementation contract

## Scope and compatibility

Evide is a local VS Code sidebar extension and a loopback-only web runner on port
4545. Both use the same TypeScript generation engine. A configured
OpenAI-compatible Chat Completions endpoint interprets Korean or English natural
language into a strictly validated project plan. There is **no offline or
success-shaped fallback** when the provider fails.

The initial supported generation language is explicitly bounded: one to four
independently persisted domain services, one entity per service, CRUD, bounded
string/long/decimal/boolean/date fields, paginated whitelist search, and optional
PENDING -> APPROVED/REJECTED workflows. Unsupported business requirements must be
returned as `unsupportedRequirements` and block generation rather than disappear.
LLM interpretation requires human review; a model cannot certify requirement
completeness. The provider receives only the submitted prompt, not workspace files.

Baseline: Java 17, Spring Boot 3.5.6 (Spring Framework 6.2.11), Spring Cloud
2025.0.0, eGovFrame runtime 5.0.0, Jakarta Validation 3 / Servlet 6 APIs.
This is a Jakarta-namespace Spring application, **not** a certified full Jakarta EE
10 application server implementation. Standard Java SE `javax` packages are not
equivalent to legacy Java EE APIs; this generator emits no `javax.*` imports.

Official eGovFrame 5 changed `Mapper` to **`EgovMapper`** on 2025-07-17.
Generated implementations extend `EgovAbstractServiceImpl`, and MyBatis scans
`EgovMapper` with a Spring-managed session factory. The old annotation must not
be generated merely to match an inaccurate example.
Each domain also supplies the superclass's required `leaveaTrace` and
`messageSource` beans with a configured eGov trace handler; inheritance alone is
not a runnable eGov service configuration.

## Ownership and ordering

```mermaid
sequenceDiagram
  participant U as Web / Webview UI
  participant S as GenerationSession (sole result owner)
  participant L as configured LLM
  participant G as deterministic generator + validator
  participant A as optional local Archify process
  participant F as filesystem apply
  U->>S: generate(prompt)
  S->>S: acquire busy gate; invalidate previous result
  S->>L: prompt -> JSON plan (timeout; bounded response)
  L-->>S: plan or explicit failure
  S->>G: validate plan; generate source/DDL/PMO/IR
  G-->>S: files + static findings
  S->>A: deliver each typed IR if installed
  A-->>S: HTML or WARN with preserved IR
  S-->>U: immutable generation id + result; release busy gate
  U->>S: apply/export(id)
  S->>S: reject stale id or concurrent generation
  S->>F: validate paths; stage; atomic rename to NEW project folder
  F-->>U: committed location or explicit error
```

The UI owns only draft text, selection, and busy presentation. The session owns
the current generated artifact. No endpoint accepts client-authored generated
files or arbitrary filesystem paths. Apply never overwrites an existing project.
VS Code requires workspace trust and explicit modal confirmation before apply.
The web runner writes only beneath its configured output root.
The web host may load its operator-owned root `.env` asynchronously for each
generation; this file is never returned, logged, copied, exported, or read from a
generated workspace. VS Code uses process environment / SecretStorage instead.

## Generated project

* `EurekaServer`: 8761, registry.
* `ConfigServer`: 8888, native, non-secret central configuration.
* `GatewayServer`: 9000, explicit `lb://EGOV<DOMAIN>` routes, credential-free
  allowlisted CORS, JWT resource-server validation and Actuator health.
* `Egov<Domain>`: 9101 upwards, separate schema and separate PostgreSQL database
  in Compose; H2 isolated database for local tests. No cross-service SQL FK.
* Central Config import is mandatory only under the explicit `cloud` profile.
  Compose/Kubernetes activate it and require all database settings. Local tests
  have no config import, so disabling ConfigClient never leaves an unresolved
  `configserver:` location in test startup.
* CRUD controllers use request DTOs with Jakarta constraints. Audit fields and
  approval actors originate from validated JWT subjects, never request JSON.
* Authorization uses `records.read`, `records.write`, `records.approve` scopes.
  Agency-specific object-level authorization and identity provisioning remain
  deployment responsibilities and are identified in the quality document.
* SQL uses `#{}` only. Search columns come from generated `<choose>` branches.
* Approval changes are atomic SQL updates from PENDING only; terminal records
  cannot be silently edited or approved twice. Rejection requires a reason.
* All modules have multi-stage Java 17 Dockerfiles, UID 10001, Kubernetes probes,
  resource limits, non-root security contexts and secret references. Network
  isolation is declared; deployment requires real registry images and secrets.
* Exactly five PMO Markdown documents contain plan-derived REQ/API/test IDs,
  assumptions, a relative milestone schedule, and **estimated** workload.
  These are reviewable drafts, not an official audit or certified FP count.

## Interfaces

`EVide` Activity Bar -> `egovvibe.sidebar`.
Messages: `generate`, `apply`, `export`; all validate payloads and generation IDs.
Browser API: `GET /api/session`, `POST /api/generate`, `POST /api/apply`,
`GET /api/export?id=...`. Mutation requests need a per-process token. Requests
with foreign Host or Origin are rejected. Only loopback binding is supported.
Provider configuration uses the ASCII names `EVIDE_LLM_BASE_URL`, `EVIDE_LLM_MODEL`,
`EVIDE_LLM_API_KEY`. Credentials stay in process environment, never results/logs.
HTTPS is required except loopback endpoints for local models.

Archify is optional at `vendor/archify/archify/bin/archify.mjs` or the explicit
trusted `EVIDE_ARCHIFY_CLI` path. Its actual Node CLI receives typed schema v1
`architecture`, `erd`, `class`, `tree` IR through `deliver`. Missing/failed/timed
out Archify yields visible WARNs, preserves IR, and never claims rendered success.
Rendered HTML is displayed in a sandboxed iframe, never injected into the host DOM.
Source analysis is local and bounded to generated artifacts; it reports file and
line evidence for Java type declarations, imports, inheritance and mapper SQL,
without claiming whole-program semantic analysis.

## Acceptance catalog

| ID | Scenario | Expected evidence |
|---|---|---|
| A01 | Configured provider receives a Korean prompt | Actual HTTP request; validated JSON plan, no keyword fallback |
| A02 | Missing key / HTTP failure / malformed JSON / unsupported capability | Explicit error; no result to apply |
| A03 | Unsafe or duplicate names / reserved audit fields | Plan rejected before source generation |
| A04 | CRUD-only and approval services | Matching Java, XML, DDL, routes and PMO interfaces |
| A05 | Audit spoofing / invalid request / no scope | Generated integration tests reject input or access |
| A06 | Approval twice / terminal mutation / rejection without reason | Explicit conflict or validation error |
| A07 | All generated source static rules | Validator findings + failing validation blocks output |
| A08 | Archify absent / failing / installed | Preserved four IRs + WARN, or real HTML and success status |
| A09 | Concurrent generation / stale apply / conflicting destination | Rejected; existing files untouched |
| A10 | Traversal, symlink, invalid project paths | Rejected before writes outside output root |
| A11 | Web generate -> preview -> PMO -> Archify -> ZIP -> apply | Browser E2E with mock HTTP provider, not a production fallback |
| A12 | VS Code sidebar packaged | VSIX contains activation, Webview View and UI assets; host validation reported separately |
| A13 | Generated Maven reactor | `mvn test` with Java 17; report actual outcome, not static proxy |
| A14 | Repository quality | `npm run typecheck`, `npm run lint`, focused tests and build |
| A15 | Local execution | Explicit project path -> Maven package (tests included) -> real JAR processes -> readiness + authenticated Gateway CRUD |

## Local execution contract

`scripts/local-java.mjs --project <generated-root>` runs only an explicitly
selected generated project. It uses installed Java/Maven or the isolated `.tools`
toolchain, never installs Docker or disables authentication. It refuses occupied
ports, packages with tests, and starts Config/Eureka, domain services and Gateway
from their actual executable JARs. The cloud profile uses explicitly supplied
isolated H2 settings for this local-only run, not a PostgreSQL deployment claim.

A separate loopback-only developer helper on 4546 supplies an ephemeral RSA JWK
and short-lived, explicitly development-only JWTs. Its browser API explorer calls
Gateway 9000 using these JWTs. No signing key is written to disk or bundled in
generated production code. This helper is not an IdP or production auth mode.
Successful startup requires actual health checks and routed authenticated API
responses, not only process existence. Shutdown stops only this runner's children.
Real LLM generation, fixture-based generator tests, JVM/H2 verification and
Docker/PostgreSQL deployment must be reported separately.

## Evidence sources

* https://github.com/egovframework/egovframe-runtime/blob/main/pom.xml
* https://maven.egovframe.go.kr/maven/org/egovframe/rte/egovframe-rte-fdl-cmmn/5.0.0/
* https://github.com/egovframework/egovframe-runtime/blob/main/Persistence/org.egovframe.rte.psl.dataaccess/src/main/java/org/egovframe/rte/psl/dataaccess/mapper/EgovMapper.java
* https://github.com/tt-a1i/archify/tree/main/archify/schemas
* https://github.com/tt-a1i/archify/blob/main/archify/SKILL.md
* https://www.egovframe.go.kr/
* https://www.kisa.or.kr/ (secure development guidance; manual rule review required)
