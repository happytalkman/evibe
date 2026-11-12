# Evide — eGov Java 생성·검증 엔진

자연어를 실제 OpenAI 호환 LLM으로 해석한 뒤, 검증된 템플릿으로 Java·DDL·PMO
문서·Archify IR을 생성합니다. LLM 실패 시 오프라인 생성으로 대체하지 않습니다.

**범위:** 서비스 1–4개, 서비스별 단일 엔터티 CRUD·검색·승인/반려.
지원하지 않는 요구사항은 생성 전에 오류로 반환합니다. 전체 Jakarta EE 인증,
전자정부 적합성 인증 또는 행안부 시큐어코딩 전수 심사를 보증하지 않습니다.
[제품·검증 명세](spec/product.md)를 확인하세요.

## 웹 러너

Node 22.18 이상:

```powershell
Set-Location E:\evide
npm ci
npm run build
Copy-Item .env.example .env
# 로컬 편집기로 .env의 URL·모델·API 키를 입력하세요. 채팅에는 키를 보내지 마세요.
npm start
```

브라우저: **http://127.0.0.1:4545/**.
`.env`는 Git·VSIX·생성 ZIP에서 제외됩니다. 생성할 때마다 비동기로 다시 읽으므로
LLM 설정 변경 후 서버를 재시작할 필요가 없습니다. 키는 브라우저로 반환하지 않습니다.
현재 프로세스 환경변수도 지원하며, `.env`에 있는 동일 이름의 값이 우선합니다.

예시 입력:

> 민원 접수와 공지 서비스를 만들어줘. 민원은 제목·내용이 필수이며 담당자가
> 승인하거나 사유를 입력해 반려할 수 있어야 해. 공지는 제목과 내용을 관리해줘.

설계 가정 확인 → 소스/DDL·PMO·소스 분석 검토 → **적용**.
적용 위치는 `generated\<projectName>`이며 기존 폴더를 덮어쓰지 않습니다.
ZIP 내보내기와 선택 파일 저장도 지원합니다.

## 생성 코드를 실제 빌드·기동

JDK 17 + Maven 3.9 이상이 필요합니다. 이 환경에서는 프로젝트 내부의
`.tools\jdk`와 `.tools\apache-maven-3.9.9`도 자동 탐색합니다.
Docker 없이 JVM과 독립 H2 DB로 실행할 수 있습니다.

```powershell
npm run local:java -- --project E:\evide\generated\<실제-프로젝트명>
```

이 명령은 **Maven package(시험 포함)** 성공 후 실제 JAR들을 실행하며, 헬스와
인증된 Gateway API 응답까지 확인합니다. 하나라도 실패하면 성공으로 표시하지
않습니다. 종료는 해당 터미널에서 `Ctrl+C`로 합니다.

| 주소 | 용도 |
|---|---|
| http://127.0.0.1:4546/ | 개발 전용 JWT를 사용하는 API 확인 페이지 |
| http://127.0.0.1:9000/actuator/health | Gateway 상태 |
| http://127.0.0.1:8761/ | Eureka 등록 서비스 |
| http://127.0.0.1:8888/actuator/health | Config Server 상태 |
| http://127.0.0.1:9101/actuator/health | 첫 번째 도메인 서비스 상태 |

4546은 루프백 전용 **개발 도우미**입니다. 서명 키는 매번 메모리에서 생성하고
짧은 수명의 시험 JWT만 발급합니다. 인증을 비활성화하지 않으며 운영 코드에
키나 개발 발급기를 넣지 않습니다. 운영 배포는 기관 IdP·PostgreSQL·비밀관리·TLS
설정과 별도 보안 심사가 필요합니다.

생성물의 `compose.yml`은 서비스별 PostgreSQL을 사용합니다. Docker 설치 및
daemon 실행은 별도이며, JVM/H2 시험 통과를 Docker/PostgreSQL 검증으로
표시하지 않습니다. Kubernetes 이미지·Secret·ConfigMap도 배포 전에 준비해야 합니다.

## VS Code 사이드바

```powershell
npm run package
code --install-extension E:\evide\evide.vsix
```

VS Code에서 필요하면 창을 다시 로드하고 Activity Bar의 **Evide**를 여세요.
`Evide: Set LLM API Key` 명령에서 URL·모델·키를 설정합니다.
키는 VS Code SecretStorage에 저장됩니다. 신뢰된 워크스페이스에서만 생성·적용할
수 있으며, 적용에는 명시적 확인이 필요합니다. 웹 호스트의 `.env`는 확장에서
자동으로 읽지 않습니다.

## Archify

선택 설치:

```powershell
git clone --depth 1 --filter=blob:none --sparse https://github.com/tt-a1i/archify.git vendor\archify
git -C vendor\archify sparse-checkout set archify
```

실제 Node CLI로 architecture/erd/class/tree를 검증·렌더링합니다.
없거나 실패하면 WARN을 표시하고 네 가지 IR과 파일/행 근거가 있는 소스 분석을
보존합니다. 실패를 렌더링 성공으로 표시하지 않습니다. VSIX에는 vendor가 포함되지
않으므로 확장 프로세스에 `EVIDE_ARCHIFY_CLI`로 설치된 CLI 경로를 제공하세요.

## 검증

```powershell
npm run typecheck
npm run lint
npm test
npx playwright install chromium
npm run build
npm run test:e2e
```

HTTP 공급자 fixture를 사용하는 자동 시험은 실제 외부 LLM 시험과 구분합니다.
생성된 Maven 시험은 실제 `mvn test/package`를 실행하기 전까지 미실행 상태입니다.
명령은 [package.json](package.json)을 기준으로 합니다.

eGovFrame 5에서는 `@EgovMapper`와 `leaveaTrace` 런타임 설정을 사용합니다.
생성된 Maven validate 단계는 `javax.*` Java 소스와 MyBatis `${}`를 발견하면
빌드를 차단합니다. 이것만으로 모든 보안 규칙이 검증되는 것은 아닙니다.
