# DocFinder 운영 안내

DocFinder는 PDF·HWP·HWPX 원본을 파일명과 추출된 본문으로 찾고, 원본을 미리 보거나 내려받는 문서 라이브러리입니다. 초대 공유용 서버 모드, 개인 브라우저 모드, 로컬 폴더 모드와 공개 스냅샷을 지원합니다. AI나 OCR을 사용하지 않습니다.

## 초대한 사람만 열람하는 서버 모드

`Google 로그인 → 내 Drive 연결 → 파일 업로드 → 서버 자동 색인 → 이메일 초대 → 링크 전달` 순서입니다. 첫 로그인에 비공개 문서함이 생성됩니다. 상단 `공유 관리`에서 이메일을 등록하고 문서함 링크를 직접 전달합니다. 수신자는 등록된 Google 계정으로 로그인한 뒤 `초대 수락`을 누릅니다. Gmail 및 Google Workspace 계정을 지원하며, 다른 이메일로 만든 Google 계정은 이메일 소유 확인 기능을 추가하기 전까지 지원하지 않습니다. 열람자는 자신의 Drive를 연결할 필요가 없습니다.

호스트는 업로드·초대·권한 회수·색인 재시도를 할 수 있고 열람자는 검색·미리보기·다운로드를 할 수 있습니다. 모든 목록·검색·원문 요청은 서버에서 문서함 권한을 검사합니다. 권한 회수는 이후 요청을 차단하고 열린 화면은 3초 간격 및 탭 복귀 시 결과와 미리보기를 비웁니다. 이미 전달되거나 다운로드된 파일을 원격으로 회수하지는 못합니다.

원본은 호스트 Drive에, 문서 목록과 쪽별 본문 색인은 서버 DB에 보관합니다. 인증 정보는 열람자에게 전달하지 않습니다. 세션은 HttpOnly 쿠키로, Drive 갱신 토큰은 서버 AES-256-GCM 암호화로 관리합니다. 공유 본문 색인과 Drive 인증 정보를 브라우저 저장소에 기록하지 않습니다. 기존 정적 공개 스냅샷을 초대 공유용으로 배포하지 마십시오.

### 로컬 실행

```sh
npm ci
cp .env.example .env
npm run start:shared
```

**항상 Safari에서 `http://localhost:4175/`를 엽니다.** Google 설정이 없으면 시작 화면과 설정 안내만 표시하며 실제 로그인·Drive 연결은 사용할 수 없습니다. 테스트 로그인 우회는 운영 서버에 없습니다. 로컬에서는 `.docfinder-data/postgres`에 PGlite(PostgreSQL)를 저장하고 운영에서는 `DATABASE_URL`의 PostgreSQL을 사용합니다. `.env` 및 `.docfinder-data`는 Git·공개 배포에서 제외합니다.

### Google 운영자 등록

운영자가 한 번 등록하면 일반 사용자는 설정 값을 입력하지 않습니다.

1. [Google Cloud Console](https://console.cloud.google.com/)에서 프로젝트를 선택하거나 만들고 Google Drive API를 사용 설정합니다.
2. Google Auth Platform에 앱 이름·지원 이메일·대상을 등록합니다. Gmail도 지원하려면 External을 선택하며 테스트 단계에는 호스트·열람자 계정을 테스트 사용자로 등록합니다.
3. OAuth **웹 애플리케이션** 클라이언트를 생성합니다. 승인된 JavaScript 원본은 `http://localhost:4175`, 승인된 리디렉션 URI는 **`http://localhost:4175/api/drive/callback`**입니다. 운영에는 실제 HTTPS 주소에 같은 콜백 경로를 붙여 추가합니다.
4. 범위는 `openid`, `email`, `profile`, `https://www.googleapis.com/auth/drive.file`입니다.
5. 발급받은 값을 로컬 편집기로 `.env`의 `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`에 넣고 서버를 재시작합니다. 시크릿은 브라우저 `config.js`나 채팅에 넣지 않습니다.
6. 운영에서는 HTTPS `DOCFINDER_ORIGIN`, `DATABASE_URL` 및 64자리 16진수 `DOCFINDER_ENCRYPTION_KEY`를 설정합니다. 키는 `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'`로 한 번 생성해 비밀 설정에 보관합니다. 키를 잃거나 바꾸면 기존 Drive 연결 정보를 복호화할 수 없습니다.

공식 근거: [ID 토큰 검증](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token), [서버 OAuth와 오프라인 접근](https://developers.google.com/identity/protocols/oauth2/web-server), [Drive 파일별 권한](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

### 자동 색인·복구·운영

호스트의 문서 메뉴에서 `Drive 휴지통으로 이동`을 선택하면 공유 목록과 색인에서 제거됩니다. 원본은 Drive 휴지통에서 복원할 수 있습니다.

128MB 이하 PDF·HWP·HWPX를 지원하며 `DOCFINDER_MAX_FILE_MB`로 한도를 낮출 수 있습니다. 업로드 완료와 색인 작업을 DB에 기록하므로 브라우저를 닫아도 실행 중인 서버에서 색인합니다. 추출은 별도 Worker Thread에서 실행 시간과 JavaScript 힙을 제한합니다. `DOCFINDER_INDEX_MEMORY_MB`는 기본 512MB이며 WASM·네이티브 메모리나 전체 프로세스 메모리의 상한은 아닙니다. 중단된 작업은 10분 임대가 만료되면 복구하고, 실패는 30초 간격으로 최대 3회 자동 재시도합니다. 호스트의 `색인 다시 시도`는 원본을 중복 업로드하지 않습니다. 업로드 번호와 Drive 앱 속성으로 응답 유실 뒤 같은 업로드 재시도를 식별합니다.

연결 시 기존 앱 업로드를 서버 색인으로 가져오며 60초마다 앱 등록 파일의 수정·삭제를 확인합니다. 바뀐 버전만 추출합니다. `drive.file` 범위는 앱이 만든 파일 또는 명시적으로 허용받은 파일에 한정됩니다. 기존 임의 폴더 전체 연결, Drive 웹사이트에서 새로 추가한 모든 파일 감시, Google Docs·Sheets·Slides 변환 및 OCR은 별도 기능입니다.

검색은 서버에서 기존 쉼표 AND·구절·한글 띄어쓰기 규칙을 사용합니다. 브라우저에는 결과 발췌·쪽·일치 위치를 전달합니다. 문서함별 색인 캐시는 최대 8개를 유지하고, 키워드별 색상과 일치 위치 이동은 기존 미리보기를 사용합니다. Drive 연결 해제·권한 만료 시 원문 제공이 중단됩니다. 연결 해제는 Drive 원본 삭제나 Google 앱 동의 철회가 아닙니다.

`Dockerfile`은 프로그램·런타임과 빈 문서 목록만 포함합니다. 기존 문서·학교 매뉴얼·`.env`는 복사하지 않습니다. `compose.yaml`은 PostgreSQL과 상시 실행하는 앱·색인 작업을 구성합니다. HTTPS 리버스 프록시 뒤에 배치하고 원래 Host·Origin을 유지하십시오. `.env`에 URL-safe `POSTGRES_PASSWORD`를 추가하고 `docker compose up --build -d`로 시작할 수 있습니다. 운영은 앱 인스턴스 1개이며 DB·암호화 키를 백업해야 합니다. 운영 인증 설정이 빠지면 시작을 거부합니다. Google 동의 화면이 Testing이면 테스트 사용자 및 갱신 토큰 수명 제한이 있으므로 일반 공개 전에 운영 등록을 완료하십시오.

### 무료 서버 구성: Render + Neon

`render.yaml`은 Docker 웹 서비스를 **Free** 요금제로 구성합니다. DB는 Neon **Free** PostgreSQL의 TLS 연결 주소를 `DATABASE_URL`에 등록합니다. 결제 수단·유료 디스크·유료 DB를 추가하지 않으며 무료 한도를 초과하면 서비스를 중단하거나 사용량을 줄입니다. Render 자체 무료 PostgreSQL은 30일 만료되므로 이 구성에서 사용하지 않습니다.

1. 개인정보·기존 문서가 제외된 소스 패키지를 전용 Git 브랜치에 올리고 Render 서비스의 Docker 입력으로 선택합니다.
2. Neon에서 빈 Free 프로젝트를 만들고, 연결 주소를 Render 비밀 환경 변수에 직접 저장합니다.
3. Render가 실제 발급한 HTTPS 주소를 Google OAuth의 JavaScript 원본에 등록하고 `/api/drive/callback`을 리디렉션 URI로 등록합니다. 예상 주소를 인증 설정에 사용하지 않습니다.
4. `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `DOCFINDER_ENCRYPTION_KEY`를 Render 비밀 설정에 넣습니다. 키는 64자리 16진수로 한 번 생성하며 서버 재배포 뒤에도 같은 값을 유지합니다. 주소는 `RENDER_EXTERNAL_URL`에서 읽고 필요하면 `DOCFINDER_ORIGIN`으로 명시합니다.
5. 배포 후 `/healthz`의 HTTP 200, 미로그인 보호 경로 차단 및 실제 Google 계정 두 개의 업로드·색인·초대·권한 회수를 검증합니다. `/healthz`는 DB 연결을 확인하고 사용자 세션이나 문서 정보를 반환하지 않습니다.

무료 Render는 15분간 요청이 없으면 절전하며 다음 접속 때 깨어나는 데 약 1분이 걸릴 수 있습니다. 절전 중 자동 감시·색인은 멈추고 재개 뒤 DB의 대기 작업을 처리합니다. 로컬 디스크는 재시작 시 사라지므로 DB와 암호화 키를 외부에 보관하며, 업로드 도중 중단되면 같은 파일 업로드를 재시도합니다. 서버는 한 개만 사용하고 자동 배포는 끕니다.

Free 설정은 파일당 **32MB**, 메인 Node 힙과 색인 Worker 힙 각각 **192MB**입니다. 큰 압축 문서의 실제 메모리 사용량이 512MB 인스턴스 한도를 넘을 수 있으므로 최초 운영 검증은 작은 문서로 시작합니다. Neon 무료 DB는 프로젝트당 1GB·월 100CUh 한도가 있으며 무료 구성은 상시 실행·운영 가용성을 보장하지 않습니다. 공식 제한: [Render Free](https://render.com/docs/free), [Neon Free](https://neon.com/blog/neon-free-plan-1-gb-per-project).

### 검증 방법

`npm test`는 미로그인 차단, Origin·CSRF 검사, 초대 수락·회수, 다른 계정·문서함 격리, 원문 응답 중 권한 재검사, 업로드 재시도, 호스트 로그아웃 뒤 색인, 실패 재시도와 실제 PDF 추출을 검증합니다.

`DOCFINDER_QA=1 node tests/serve-shared-qa.mjs`는 localhost:4176에서 메모리 DB·합성 PDF/HWP/HWPX를 사용하는 격리된 Safari QA 서버를 시작합니다. 테스트 인증은 테스트 파일에서만 주입하며 `start:shared`에는 테스트 계정이 없습니다. 합성 QA 성공은 실제 Google 연동 성공을 의미하지 않습니다. Google 등록 후 실제 두 계정으로 로그인→Drive 연결→업로드→초대→열람→회수까지 확인해야 합니다.

서버 없이 혼자 사용하는 경우에는 아래 **개인 Drive 문서함**을 사용합니다. 개인 배포에는 기존 문서와 검색 색인을 넣지 않습니다.

| 구분 | 로컬 비공개 프로필 | 스테이징/공개 스냅샷 프로필 |
| --- | --- | --- |
| 입력 | 운영자가 지정한 자기 문서 폴더 | 운영자가 지정하고 검토한 자기 문서 폴더 |
| 생성물 | `private/`의 로컬 색인과 로컬 원본 링크 | `dist/`의 복사된 원본, 카탈로그, 검색 색인, 매니페스트 |
| 접속 | `127.0.0.1`에 바인딩한 로컬 서버만 | HTTPS 정적 호스팅에서 누구나 접근 가능 |
| 연결/편집 | 로컬 작업 설정 | Drive 연결, OAuth, 편집기 기능 없음 |

공개 프로필은 데스크톱에서 목록 약 40%·원본 미리보기 약 60%의 두 패널을 유지합니다. PDF는 PDF.js로, HWP/HWPX는 RHWP로 원본을 연속 미리 보기 합니다. 공개 스냅샷의 원본과 추출 텍스트는 공개 대상입니다. URL의 추측 난이도는 접근 제어가 아니며, 내려받은 사본은 나중에 회수할 수 없습니다.

## 사전 조건

- Node.js **22.13 이상**과 npm
- 지원 파일만 들어 있는, 본인이 소유·검토할 수 있는 문서 폴더
- 공개 배포 시 Cloudflare 계정과 Wrangler 인증

`<DocFinder-root>`는 `package.json`, `scripts/`, `tests/`가 바로 들어 있는 디렉터리입니다. 5E 작업 사본에서는 한 번만 `cd manual-library` 하여 그 루트를 열고, 배포용 소스 패키지를 풀거나 포크한 사본에서는 그 사본 자체가 `<DocFinder-root>`입니다. 아래의 모든 명령은 이미 `<DocFinder-root>`에 있다고 가정하므로, 독립 소스 패키지 안에서 다시 `cd manual-library`를 실행하지 마십시오.

```bash
# 5E 작업 사본에서 시작할 때만
cd manual-library
npm ci
```

독립 소스 패키지 또는 포크 사본에서는 그 최상위 디렉터리에서 `npm ci`만 실행합니다. `<내-문서-폴더>`와 `<임시-배포-폴더>`는 각자가 만든 경로로 바꾸십시오. 실제 문서명, 학교명, 계정 정보, 로컬 경로를 명령 기록·저장소·스크린샷에 남기지 마십시오.

## 개인 Drive 문서함

`Drive 연결 → 파일 업로드 → 자동 본문 색인 → 검색·원문 미리보기` 순서입니다. 사용자는 각자의 Google 계정을 연결하고 PDF·HWP·HWPX를 선택합니다. 프로그램이 그 계정의 `DocFinder` 폴더를 만들거나 재사용하고 파일을 올립니다. 업로드가 끝나면 Web Worker가 선택한 파일을 쪽별로 분석합니다. 업로드·색인 진행을 화면에서 보여주며, 실패한 색인은 문서 메뉴의 `색인 다시 시도`로 처리합니다. 이 재시도는 원본을 중복 업로드하지 않습니다.

접근 권한은 `drive.file` 하나입니다. 전체 Drive를 탐색하지 않고 이 앱이 올린 문서만 목록에 표시합니다. 기존 Drive 문서를 고르는 Picker, Google Docs·Sheets·Slides 변환, Drive 웹사이트에서 추가한 파일의 자동 감시는 구현하지 않았습니다. 앱에서 올린 파일을 Drive에서 수정·삭제한 경우에는 `목록 새로고침` 또는 재연결 시 변경을 반영하고 바뀐 파일만 다시 색인합니다. 텍스트가 없는 스캔은 `본문 없음`으로 표시하며 OCR은 수행하지 않습니다.

원본은 개인 Drive에 보관하고 공개 호스팅에 복사하지 않습니다. 쪽별 검색 텍스트와 목록은 해당 브라우저의 IndexedDB에 계정·폴더별로 저장합니다. 토큰은 현재 탭 메모리에만 두고 저장소에 기록하지 않습니다. 다시 연결하면 유효한 색인을 재사용합니다. 다른 기기·다른 사이트 주소·Safari 개인정보 보호 브라우징에서는 같은 저장소를 쓸 수 없으므로 다시 색인합니다. 저장 공간을 사용할 수 없는 경우에는 현재 탭에서만 동작하고 안내를 표시합니다. `Drive 연결 해제`는 화면과 탭의 인증 상태를 비우며 Drive 원본을 삭제하거나 Google 계정에서 앱 권한을 철회하는 동작은 아닙니다.

Google 없이 확인할 때는 `이 컴퓨터에서 불러오기`를 사용합니다. 선택한 파일의 원본과 색인을 이 브라우저에 저장하며 외부로 업로드하지 않습니다. 다시 열었을 때 `도구 → 저장한 로컬 문서 열기`로 복원합니다. 로컬 파일 선택은 일회성 가져오기이므로 원본 폴더의 변경을 계속 감시하지 않습니다. 자동 폴더 감시는 아래 Node 로컬 프로필을 사용합니다.

### 운영자 Google OAuth 설정

운영자가 한 번 설정하면 일반 사용자가 클라이언트 ID를 입력할 필요는 없습니다. 아직 기본 소스에는 ID가 등록되지 않았으므로 실제 Google 연결은 이 설정을 마친 뒤 검증해야 합니다.

1. 운영자 Google Cloud 프로젝트에서 **Google Drive API**를 사용 설정합니다.
2. Google Auth Platform에 앱 이름·지원 이메일·대상 사용자를 설정합니다. 개인 Google 계정도 받을 경우 External 대상을 선택하고 테스트 단계에는 테스트 사용자를 등록합니다.
3. 데이터 액세스 범위에 `https://www.googleapis.com/auth/drive.file`을 등록합니다.
4. **웹 애플리케이션** OAuth 클라이언트를 만들고 승인된 JavaScript 원본에 실제 앱의 HTTPS 원본을 추가합니다. 로컬 테스트에는 `http://localhost`와 `http://localhost:4174`를 추가하고 Safari에서 그 주소를 사용합니다. 다른 포트를 쓰면 그 원본도 정확히 등록합니다. 경로나 슬래시를 붙이지 않습니다.
5. 생성된 `….apps.googleusercontent.com` 클라이언트 ID로 아래 개인 배포를 빌드합니다. **클라이언트 시크릿은 이 브라우저 앱에 넣지 않습니다.**

```bash
npm run build:personal -- --output "<새-개인앱-배포-폴더>" --client-id "<OAuth-웹-클라이언트-ID>"
node scripts/release-package.mjs verify personal "<새-개인앱-배포-폴더>"
```

이 출력은 프로그램·벤더 런타임·빈 데모 데이터만 포함합니다. `library/`, `private/`, 기존 매뉴얼, 검색 텍스트, 사용자 토큰은 포함하지 않습니다. 이미 있는 출력 폴더와 합치지 않으므로 새 경로를 사용합니다. 빌드는 게시를 수행하지 않습니다. 실제 배포 전에 운영 주소·Google 동의 화면을 완성하고, 테스트 계정으로 연결·업로드·검색·재접속·권한 만료를 확인합니다.

로컬 검증은 문서 폴더를 지정하지 않고 다음으로 실행합니다.

```bash
npm start -- --personal --port 4174
```

`http://localhost:4174/`을 **항상 Safari**에서 엽니다. 이 서버는 `127.0.0.1`에만 바인딩하며 `/private/` 경로를 제공하지 않습니다. 설정에서 OAuth ID를 입력해 로컬 테스트할 수 있습니다. 실제 Google 계정 연결 전에는 로컬 파일 가져오기만 검증할 수 있습니다.

등록 절차와 권한은 [Google 웹 클라이언트 ID 안내](https://developers.google.com/identity/oauth2/web/guides/get-google-api-clientid), [Drive 파일별 접근 범위](https://developers.google.com/workspace/drive/api/guides/api-specific-auth), [브라우저 토큰 모델](https://developers.google.com/identity/oauth2/web/guides/use-token-model)을 참고합니다.

## 로컬 비공개 색인

로컬 색인은 지정 폴더의 PDF·HWP·HWPX를 읽어 `private/`에만 만듭니다. 이 폴더에는 원문으로 가는 링크와 추출 텍스트가 들어갈 수 있으므로 Git·소스 패키지·공개 호스팅에 넣지 않습니다.

```bash
npm start -- "<내-문서-폴더>"
```

`http://127.0.0.1:4173/`을 **Safari**에서 엽니다. 로컬 서버는 `127.0.0.1`에만 바인딩하고 연결한 문서 폴더의 추가·변경·이름 변경·삭제를 자동 반영합니다. 파일 저장이 끝나기를 기다린 뒤 내용 해시가 바뀐 문서만 다시 추출합니다. 폴더 이벤트를 놓치는 경우에도 5초 간격의 재확인으로 복구합니다. Google Drive 등 macOS `CloudStorage` 폴더에서는 운영체제 파일 감시가 대기하는 문제를 피하도록 주기적인 재확인만 사용합니다. 열린 화면은 새 색인을 2초 간격으로 확인하고 검색 결과와 목록을 갱신합니다.

macOS에서 로그인할 때 자동으로 서버와 폴더 감시를 시작하려면 다음을 한 번 실행합니다.

```bash
npm run service:install -- "<내-문서-폴더>"
```

`~/Library/LaunchAgents/local.docfinder.plist`에 해당 사용자용 설정을 저장합니다. 서버가 이미 실행 중이면 중복 실행하지 말고 기존 서비스를 사용하십시오. 자동 실행을 해제하려면 `launchctl bootout "gui/$(id -u)/local.docfinder"`를 실행한 뒤 해당 plist만 제거합니다. 다시 설치하기 전까지 자동 실행이 중단됩니다. 로그는 `~/Library/Logs/DocFinder/`에 있습니다. 실행 파일은 `~/Library/Application Support/DocFinder/app/`, 비공개 색인은 같은 폴더의 `private/`에 저장합니다. 코드가 바뀌면 `service:install`을 다시 실행해 설치된 실행 파일도 갱신합니다. 설치기는 새 서비스가 문서 목록까지 불러오는지 확인합니다. 30초 안에 확인하지 못하면 로그인 자동 실행을 끄고 설정을 `.plist.disabled`로 보관합니다. Google Drive 폴더 접근이 대기하는 환경에서는 접근 권한 확인 전까지 `npm start`를 사용하십시오.

일회성 색인 생성만 필요하면 기존 `npm run index:local -- "<내-문서-폴더>"`도 사용할 수 있습니다. 텍스트 레이어가 없는 스캔 PDF는 미리보기·다운로드는 되지만 본문 검색에는 나오지 않습니다. OCR은 수행하지 않습니다. 추출 실패가 있으면 상태 표시가 `확인 필요`로 바뀌고 자동 재시도합니다.

본문 검색에서 공백은 한 구절의 일부이고 **쉼표는 AND 구분자**입니다. `학교 폭력, 학생 자치`는 파일 전체에 두 구절이 모두 있는 문서를 찾습니다. 다른 쪽에 있는 키워드도 포함하되 같은 쪽의 가까운 일치를 우선합니다. `학교 폭력 학생 자치`는 하나의 연속 구절입니다. 한글 띄어쓰기·줄바꿈·유니코드 차이를 허용하며 쪽별 글자쌍 색인으로 후보를 좁힌 뒤 실제 구절을 확인합니다. 검색과 강조, 결과 발췌는 같은 규칙을 사용합니다.

검색어마다 고정 색상을 사용합니다. 원문 위의 번호·검색어 범례, 결과 발췌와 오른쪽 전체 페이지 위치 표시가 같은 색을 사용합니다. `일치 위치 n/m`의 이전·다음은 같은 쪽 안의 여러 일치와 다른 쪽의 일치 사이를 이동합니다. `쪽 목록`으로 바로 이동할 수 있고, 오른쪽 표시가 겹치면 묶인 쪽의 목록을 표시합니다. 위치 표시는 페이지 단위이며 페이지 안의 정확한 위치는 실제 원문 글자 좌표로 이동합니다. 좌표를 확인할 수 없는 한글 문서는 검색 발췌를 대신 표시합니다.

한글 미리보기는 편집기 프레임을 열지 않고 별도의 Web Worker에서 RHWP 읽기용 코어로 문서를 한 번 분석합니다. 최근 2개 문서와 최대 8MiB의 SVG·좌표 결과를 캐시합니다. PDF는 선택한 쪽을 우선 렌더링하고 작업을 최대 2개로 제한합니다. 미리보기의 최근 쪽은 최대 6개까지 유지하고 PDF 캔버스는 32MiB, 한글 SVG는 8MiB를 기준으로 화면 밖의 쪽을 정리합니다. 현재 보이는 쪽은 이 한도에서 제외해 읽는 중 원문을 지우지 않습니다. 원본 바이트는 최대 48MiB·8개까지 캐시하며, 검색어 변경 시 같은 문서의 렌더러를 재사용합니다. 새 원본 URL·수정 시각은 캐시를 갱신합니다. 화면 폭을 바꿔도 읽던 쪽과 위치를 유지합니다. 이 캐시는 현재 탭의 메모리에만 보관합니다.

상단 `색인 n/n`을 누르면 본문 검색 가능한 문서·쪽, 추출 실패, 텍스트 없는 문서·쪽과 문서별 상태를 확인할 수 있습니다. 공백만 있는 쪽도 텍스트 없는 쪽으로 집계합니다. 이 수치는 추출된 텍스트의 존재 여부를 나타내며, 이미지 속 글자의 인식이나 추출 품질을 보장하지 않습니다.

폴더 자동 감시는 **로컬 서버**의 기능입니다. 기존 Cloudflare Pages 주소는 명시적으로 만든 공개 스냅샷을 사용하므로, 로컬 색인 갱신이 그 주소를 자동으로 배포하거나 바꾸지는 않습니다.

## 공개 스냅샷 만들기

`build:public`은 동기화나 자동 게시가 아닙니다. 지정 폴더를 읽어 새 `dist/`를 원자적으로 만들 뿐입니다. 공개 승인 파일만 담긴 별도 폴더를 지정하십시오. 지원하지 않는 일반 파일, 읽을 수 없는 파일, 중첩 심볼릭 링크, 추출 오류가 있으면 실패하며 기존 성공 출력은 유지합니다.

```bash
npm run build:public -- --source "<내-문서-폴더>" --output "<임시-배포-폴더>"
node scripts/release-package.mjs verify deploy "<임시-배포-폴더>"
```

빌드는 지원 입력·카탈로그·검색 색인·복사 원본의 ID 집합과 원본 SHA-256을 대조합니다. 출력에는 앱 정적 자산과 `library/`만 들어갑니다. `private/`, `.omo/`, `evidence/`, `node_modules/`, `.git/`, 소스 트리, 로컬 설정은 배포 대상이 아닙니다.

동일 출력 폴더를 다음 빌드에도 사용하면 `library/manifest.json`의 `delta.added`, `delta.changed`, `delta.removed`가 직전 성공 스냅샷의 차이를 기록합니다. 파일명·본문 없이 건수만 확인하려면 다음을 실행합니다.

```bash
node -e 'const m=require(process.argv[1]); console.log(Object.fromEntries(Object.entries(m.delta).map(([k,v])=>[k,v.length])))' "<임시-배포-폴더>/library/manifest.json"
```

추가·변경·삭제와 텍스트 없는 페이지 경고를 매번 검토하십시오. **폴더 동기화나 로컬 색인만으로는 게시되지 않습니다.** 콘텐츠 소유자가 그 매니페스트를 검토해 이번 export·deploy를 명시적으로 승인한 경우에만 배포합니다.

## 테스트와 스테이징 확인

새 포크 또는 소스 패키지는 개인 문서와 `private/` 폴더 없이 먼저 의존성을 설치하고 전체 Node 테스트를 실행할 수 있습니다. 테스트가 끝난 뒤에만 자신의 문서 폴더를 `index:local` 또는 `build:public -- --source`에 전달하십시오.

```bash
npm ci
npm test
```

공개 결과물의 브라우저 스모크는 생성된 정적 폴더만 제공하며 검색, 깊은 링크, 원본 다운로드 바이트 일치, 금지 경로 404, 공개 모드의 Drive/OAuth 비사용, 375/768/1280 뷰포트를 검사합니다. 이 명령에는 `playwright` 모듈과 브라우저가 설치된 테스트 환경이 필요합니다.

```bash
npm run qa:public -- --dist "<임시-배포-폴더>" --browsers chromium
```

사람이 열어 볼 때도 앱 원본 폴더가 아니라 배포 폴더만 제공하십시오.

```bash
python3 -m http.server 4173 --bind 127.0.0.1 --directory "<임시-배포-폴더>"
```

## Cloudflare Pages Direct Upload

공개 배포는 Git 연동이 아니라 **Direct Upload**를 사용합니다. 소스 저장소가 아니라 승인·검증한 `dist/` 폴더 하나만 업로드합니다. Direct Upload 프로젝트는 나중에 Git integration으로 바꿀 수 없으므로, 처음 만들기 전에 선택을 확인하십시오.

명시적 배포 승인을 받은 뒤에만 다음을 실행합니다. 새 포크의 공개 URL은 아래 프로젝트 확인 절차로 확정합니다. 콘텐츠 소유자는 매니페스트 승인과 함께 정확한 `<소유자-승인-프로젝트명>` 및 예상 URL `https://<소유자-승인-프로젝트명>.pages.dev`를 승인·기록해야 합니다. `docfinder`를 쓰려면 그 정확한 이름을 승인값으로 적습니다. Wrangler가 이름 충돌로 다른 이름·접미사를 제시하거나 생성 결과가 승인값과 다르면 **업로드하지 말고 중단**하여 소유자의 새 승인을 받으십시오. 안정 URL은 승인된 `<프로젝트명>.pages.dev`이며 이 절차에서는 사용자 지정 도메인을 설정하지 않습니다.

Wrangler는 AI 에이전트 환경에서 새 정적 Pages 프로젝트 생성 명령을 Workers 배포로 자동 위임할 수 있습니다. 아래는 직접 Pages 생성을 확인한 **4.141.0**으로 버전을 고정하고 `--force`로 그 위임을 해제합니다. 이 옵션은 이름 충돌이나 소유자의 승인을 우회하지 않습니다. 버전을 바꿀 때는 이 동작을 다시 확인하십시오. 생성은 저장소·Wrangler 설정 트리 밖의 새 빈 폴더와 별도 캐시에서 실행합니다. 이 절의 서브셸만 해당 폴더로 이동하며 `<배포-폴더-절대경로>`는 앞서 검증한 출력 폴더의 절대경로로 바꿉니다.

```bash
npx --yes wrangler@4.141.0 login
npx --yes wrangler@4.141.0 whoami
```

인증된 계정이 소유자가 승인한 계정인지 확인한 뒤, 새 프로젝트를 만들 때만 실행합니다. 이미 존재하는 프로젝트는 생성하지 말고 같은 Pages 목록·대시보드 확인을 수행합니다.

```bash
docfinder_ops_dir="$(mktemp -d)"
(
  cd "$docfinder_ops_dir" || exit 1
  export WRANGLER_CACHE_DIR="$docfinder_ops_dir/.wrangler-cache"
  npx --yes wrangler@4.141.0 pages project create "<소유자-승인-프로젝트명>" --production-branch main --force || exit 1
  npx --yes wrangler@4.141.0 pages project list --json
)
```

**업로드 전 중단 지점:** Pages 목록과 Cloudflare 대시보드에서 리소스 유형이 **Pages**이고, 계정·프로젝트명·`pages.dev` 호스트·production 브랜치 `main`이 승인값과 일치하는지 확인·기록합니다. Worker 또는 `workers.dev` 주소가 보이거나 확인할 수 없으면 업로드하지 않습니다. 생성 성공 문구만으로 이 확인을 대신하지 마십시오. 확인을 통과한 뒤에만 아래 업로드를 실행합니다.

```bash
docfinder_upload_dir="$(mktemp -d)"
(
  cd "$docfinder_upload_dir" || exit 1
  export WRANGLER_CACHE_DIR="$docfinder_upload_dir/.wrangler-cache"
  npx --yes wrangler@4.141.0 pages deploy "<배포-폴더-절대경로>" --project-name "<소유자-승인-프로젝트명>" --branch main || exit 1
  npx --yes wrangler@4.141.0 pages deployment list --project-name "<소유자-승인-프로젝트명>" --json
)
```

배포 전·후에는 배포 이력과 실제 URL을 기록하고, 비로그인 브라우저에서 카탈로그·검색·미리보기·다운로드를 다시 확인합니다. Wrangler Direct Upload 한도는 파일 최대 20,000개, 파일 하나당 최대 25 MiB이며 ZIP이 아니라 단일 정적 폴더를 올립니다.

배포 폴더 루트의 `404.html`은 필수입니다. [Pages의 서빙 규칙](https://developers.cloudflare.com/pages/configuration/serving-pages/)에 따라 이 파일이 없으면 없는 경로도 SPA 기본 동작으로 앱 루트에 연결될 수 있습니다. 빌더가 복사한 `404.html`을 유지하고, 실제 배포 URL에서 없는 경로와 `/private/`, `/.git/config` 같은 금지 경로가 앱 화면이나 HTTP 200 대신 **HTTP 404**를 반환하는지 확인합니다.

## 업데이트, 롤백, 긴급 제거

1. 공개 승인 범위만 담긴 자기 문서 폴더를 준비합니다.
2. 같은 배포 출력 폴더로 `build:public`을 실행합니다.
3. 매니페스트의 추가·변경·삭제와 경고를 검토하고 `verify deploy`, `npm test`, 브라우저 스모크를 통과시킵니다.
4. 콘텐츠 소유자가 **명시적으로 승인**한 경우에만 `wrangler pages deploy`로 그 출력 폴더를 올립니다.

빌더가 생성하는 `_headers`는 `library/catalog.json`·`library/search-index.json`·`library/manifest.json`에 `Cache-Control: no-store`를, 해시가 포함된 `library/originals/*`에는 `Cache-Control: public, max-age=31536000, immutable`를 적용합니다. 즉 메타데이터는 캐시하지 않고, 원본 URL을 이미 방문한 브라우저는 최대 1년 동안 그 사본을 재사용할 수 있습니다. Cloudflare Pages의 `_headers` 규칙은 일반 정적 응답 헤더를 덮어씁니다.

잘못된 공개는 즉시 링크 배포를 중단합니다. Cloudflare Pages 대시보드의 **Deployments**에서 이전의 성공한 **production** 배포를 선택해 `Rollback to this deployment`을 확인합니다. preview 배포는 롤백 대상이 아닙니다. 원본 자체를 긴급 제거해야 하면 공개 배포와 공유 링크를 중단·회수하고 Cloudflare 대시보드에서 프로젝트의 공개 배포를 제거한 뒤 책임자에게 알립니다. 이어 비로그인 새 브라우저에서 production URL과 각 메타데이터 URL을 확인합니다. 새 배포 뒤에도 CDN에서 오래된 자산이 관찰되면, 관리 중인 해당 Cloudflare zone에서 공식 **Caching > Configuration > Purge Everything** 절차를 수행하고 다시 확인합니다. Pages 자산은 데이터센터별로 최대 1주일 남을 수 있고, 브라우저의 immutable 사본·이미 내려받거나 복사된 원본·검색 텍스트는 롤백·배포 제거·캐시 퍼지로 회수하거나 폐기할 수 없습니다. 퍼지는 최신 배포의 오래된 CDN 응답을 완화하는 절차일 뿐, 이미 공개된 바이트의 회수 보장이 아닙니다.

## 포크 가능한 소스 패키지

공개 소스에는 코드·테스트·벤더 런타임·README·잠금 파일만 넣습니다. 실제 문서, 생성된 `dist/`, 생성된 `catalog.json`·`search-index.json`·`manifest.json`, `private/`, 근거 자료, 스크린샷, 의존성 폴더, 로컬 경로·토큰은 포함하지 않습니다. 패키징은 허용 목록만 복사하며, 기존 출력과 합치지 않습니다.

5E 작업 사본에서 소스 패키지를 만들 때만, 그 작업 사본의 `manual-library`에 한 번 들어가 다음을 실행합니다.

```bash
cd manual-library
node scripts/release-package.mjs package source . "../docfinder-source"
node scripts/release-package.mjs verify source "../docfinder-source"
```

포크 사용자는 자신의 빈 작업 사본에서 `npm ci`를 실행하고 자신의 문서 폴더만 `index:local` 또는 `build:public -- --source`에 전달합니다. 같은 5E 저장소나 다른 프로젝트 원격에 밀어 넣지 마십시오. 별도 `docfinder` 원격의 이름·권한을 읽기 전용으로 확인한 뒤에만 새 원격에 게시합니다.

## 학교망 제한은 아직 적용되지 않음

이 절차는 학교망/IP 제한을 설정하지 않습니다. 이 운영 설계에서 배포된 스냅샷은 `pages.dev`에서 공개이며 로그인·OAuth·비밀번호가 없습니다. 장래에 학교망만 허용하려면 검증된 학교 IPv4·IPv6 egress 범위, VPN/프록시 정책, 관리되는 edge 또는 도메인과 Cloudflare Access 정책을 준비해야 합니다. 기본 `pages.dev`와 preview 주소 같은 대체 경로도 함께 닫히는지 검증해야 합니다. 이 조건을 모두 설계·검증하기 전에는 학교망 제한이 활성화되었다고 주장하면 안 됩니다.

## 공식 참고

- [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Cloudflare Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/)
- [Cloudflare Pages serving and cache behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/)
- [Cloudflare Pages `_headers`](https://developers.cloudflare.com/pages/configuration/headers/)
- [Cloudflare cache purge](https://developers.cloudflare.com/cache/how-to/purge-cache/)

Drive API의 구절 검색 규칙: https://developers.google.com/workspace/drive/api/guides/ref-search-terms
