# DocFinder 운영 안내

DocFinder는 PDF·HWP·HWPX 원본을 파일명과 추출된 본문으로 찾고, 원본을 미리 보거나 내려받는 정적 문서 라이브러리입니다. AI나 OCR을 사용하지 않습니다.

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

## 로컬 비공개 색인

로컬 색인은 지정 폴더의 PDF·HWP·HWPX를 읽어 `private/`에만 만듭니다. 이 폴더에는 원문으로 가는 링크와 추출 텍스트가 들어갈 수 있으므로 Git·소스 패키지·공개 호스팅에 넣지 않습니다.

```bash
npm run index:local -- "<내-문서-폴더>"
python3 -m http.server 4173 --bind 127.0.0.1
```

`http://127.0.0.1:4173/`을 엽니다. 서버는 반드시 `127.0.0.1`에만 바인딩합니다. `목록 새로고침`은 기존 색인만 다시 읽습니다. 파일을 추가·변경·삭제했으면 `index:local`을 다시 실행하십시오. 텍스트 레이어가 없는 스캔 PDF는 미리보기·다운로드는 되지만 본문 검색에는 나오지 않습니다. OCR은 수행하지 않습니다.

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

명시적 배포 승인을 받은 뒤에만 다음을 실행합니다. 아직 이 저장소에 실제 공개 URL은 없습니다. 콘텐츠 소유자는 매니페스트 승인과 함께 정확한 `<소유자-승인-프로젝트명>` 및 예상 URL `https://<소유자-승인-프로젝트명>.pages.dev`를 승인·기록해야 합니다. `docfinder`를 쓰려면 그 정확한 이름을 승인값으로 적습니다. Wrangler가 이름 충돌로 다른 이름·접미사를 제시하거나 생성 결과가 승인값과 다르면 **업로드하지 말고 중단**하여 소유자의 새 승인을 받으십시오. 안정 URL은 승인된 `<프로젝트명>.pages.dev`이며 이 절차에서는 사용자 지정 도메인을 설정하지 않습니다.

```bash
npx wrangler login
npx wrangler pages project create "<소유자-승인-프로젝트명>" --production-branch main
# 생성 결과의 프로젝트명과 pages.dev URL이 승인값과 정확히 일치할 때만 다음 명령을 실행
npx wrangler pages deploy "<임시-배포-폴더>" --project-name "<소유자-승인-프로젝트명>"
npx wrangler pages deployment list --project-name "<소유자-승인-프로젝트명>" --json
```

배포 전·후에는 배포 이력과 실제 URL을 기록하고, 비로그인 브라우저에서 카탈로그·검색·미리보기·다운로드를 다시 확인합니다. Wrangler Direct Upload 한도는 파일 최대 20,000개, 파일 하나당 최대 25 MiB이며 ZIP이 아니라 단일 정적 폴더를 올립니다.

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

아직 공개 URL이나 학교망/IP 제한은 활성화되어 있지 않습니다. 이 운영 설계에서 배포된 스냅샷은 `pages.dev`에서 공개이며 로그인·OAuth·비밀번호가 없습니다. 장래에 학교망만 허용하려면 검증된 학교 IPv4·IPv6 egress 범위, VPN/프록시 정책, 관리되는 edge 또는 도메인과 Cloudflare Access 정책을 준비해야 합니다. 기본 `pages.dev`와 preview 주소 같은 대체 경로도 함께 닫히는지 검증해야 합니다. 이 조건을 모두 설계·검증하기 전에는 학교망 제한이 활성화되었다고 주장하면 안 됩니다.

## 공식 참고

- [Cloudflare Pages Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
- [Cloudflare Pages limits](https://developers.cloudflare.com/pages/platform/limits/)
- [Cloudflare Pages rollbacks](https://developers.cloudflare.com/pages/configuration/rollbacks/)
- [Cloudflare Pages serving and cache behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/)
- [Cloudflare Pages `_headers`](https://developers.cloudflare.com/pages/configuration/headers/)
- [Cloudflare cache purge](https://developers.cloudflare.com/cache/how-to/purge-cache/)
