# 기말 자료실

`data` 폴더를 자동으로 읽어 폴더 탐색, 파일 다운로드, 모바일 PDF 보기를 제공하는 가벼운 Node.js 사이트입니다.

## 실행

Node.js 18 이상이 필요합니다.

```bash
npm install
npm start
```

기본 주소는 `http://0.0.0.0:3000`입니다. 브라우저에서는 서버의 IP 주소와 포트로 접속합니다.

개발 중 파일 변경을 감지해 서버를 다시 시작하려면:

```bash
npm run dev
```

## 환경 변수

- `PORT`: 서버 포트, 기본값 `3000`
- `HOST`: 바인딩 주소, 기본값 `0.0.0.0`
- `DATA_DIR`: 자료 폴더의 절대 또는 상대 경로, 기본값 `./data`

예시:

```bash
PORT=8080 DATA_DIR=/srv/exam-data npm start
```

자료는 서버 실행 중에도 `data` 폴더에 추가하거나 정리할 수 있습니다. 다음 탐색 또는 새로고침부터 변경된 구조가 표시됩니다.

## PDF 페이지 이미지 미리 생성

큰 PDF를 휴대폰에서 빠르게 열려면 배포 전이나 자료를 바꾼 뒤 아래 명령을 실행합니다.

```bash
npm run pdf:precache
```

이 명령은 `data` 폴더에 있는 각 PDF의 첫 페이지만 JPEG 이미지로 만들어 `.cache/pdf-pages`에 저장합니다. PDF.js가 원본을 불러오는 동안 이 이미지를 먼저 보여주고, 실제 첫 페이지 렌더링이 끝나면 기존 PDF 뷰어로 자동 교체합니다. 이미 생성되어 있고 원본이 바뀌지 않은 PDF는 다시 렌더링하지 않으며, 캐시가 없어도 기존 PDF 뷰어는 그대로 동작합니다. 인쇄와 다운로드에는 항상 원본 PDF가 사용됩니다.

이미지 생성에는 Poppler의 `pdfinfo`와 `pdftoppm` 명령이 필요합니다. Ubuntu에서는 먼저 설치합니다.

```bash
sudo apt update
sudo apt install -y poppler-utils
```

서버 배포 순서는 다음과 같습니다.

```bash
npm ci
npm run pdf:precache
npm start
```

캐시 이미지의 기본 너비는 1800px, JPEG 품질은 85입니다. 필요하면 생성할 때 환경 변수로 조정할 수 있습니다.

```bash
PDF_RENDER_WIDTH=2200 PDF_IMAGE_QUALITY=90 npm run pdf:precache
```

- `DATA_DIR`: PDF를 찾을 자료 폴더, 기본값 `./data`
- `PDF_CACHE_DIR`: 생성된 이미지와 인덱스를 저장할 폴더, 기본값 `./.cache/pdf-pages`
- `PDF_RENDER_WIDTH`: 페이지 이미지 너비, 기본값 `1800` (허용 범위 `600`~`4000`)
- `PDF_IMAGE_QUALITY`: JPEG 품질, 기본값 `85` (허용 범위 `40`~`100`)
- `PDFINFO_BIN`, `PDFTOPPM_BIN`: Poppler 실행 파일이 PATH에 없을 때 사용할 절대 경로

캐시 폴더는 서버가 읽을 수 있어야 하며, 서버 실행 시에도 생성할 때와 같은 `PDF_CACHE_DIR` 값을 사용해야 합니다.

## Ubuntu 서버

```bash
sudo apt update
sudo apt install -y nodejs npm poppler-utils
git clone <repository-url>
cd <repository-directory>
npm install
PORT=3000 npm start
```

UFW를 사용하는 서버에서 포트를 직접 공개하려면:

```bash
sudo ufw allow 3000/tcp
```

인터넷에 공개할 때는 Node 포트를 직접 노출하기보다 Nginx나 Caddy에서 HTTPS를 적용하고 `http://127.0.0.1:3000`으로 프록시하는 구성을 권장합니다. 프록시에서는 PDF Range 요청을 방해하지 않도록 Range 관련 헤더를 그대로 전달해야 합니다.

## PWA 설치

사이트는 선택적으로 홈 화면 설치를 지원합니다. 오프라인 모드, 서비스 워커 기반 캐시, PDF 오프라인 저장 기능은 제공하지 않으며 자료 탐색과 PDF 열기는 항상 서버에서 처리합니다.

PWA 설치는 HTTPS 환경 또는 `localhost`에서만 동작합니다. 서버 IP로 접속하는 `http://192.168.x.x:3000` 주소에서는 브라우저 보안 정책상 설치가 활성화되지 않으므로, Ubuntu 서버에서는 HTTPS 리버스 프록시를 사용해야 합니다.

## 테스트

```bash
npm test
```

테스트는 폴더 탐색과 검색, 한글 파일명 다운로드, PDF Range 응답, 경로 탈출 차단을 확인합니다.
