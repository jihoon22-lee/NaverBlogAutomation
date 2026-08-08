# Legacy Chrome extension

Chrome extension v0.6.0은 동결 상태입니다. 새 기능과 기본 사용 흐름은 독립 실행 웹앱을 기준으로
개발됩니다. 이미 extension을 쓰고 있다면 계속 사용할 수 있지만, 보안 결함과 Chrome의 파괴적 변경을
제외한 기능 추가는 하지 않습니다.

## 설치가 필요한 경우

기존 Side Panel 흐름을 계속 사용해야 할 때만 플랫폼별 setup launcher에 `--with-extension`을 넣습니다.

```bash
# Linux·WSL
scripts/setup-linux.sh --with-extension

# macOS
scripts/setup-macos.command --with-extension

# Windows PowerShell
scripts/setup-windows.ps1 -WithExtension
```

launcher가 `extension/dist` build를 마친 뒤 Chrome의 `chrome://extensions`에서 Developer mode를 켜고
**Load unpacked**로 해당 directory를 선택하도록 안내합니다. 표시된 32자 ID를 입력하면 private env file의
`CHROME_EXTENSION_ORIGIN`만 갱신합니다. API key·쿠키·본문은 이 과정에서 표시하거나 extension으로
전달하지 않습니다.

## 웹앱과 함께 사용할 때

웹앱은 extension을 설치하지 않아도 완전히 동작합니다. extension을 함께 설정해도 두 UI의 저장 방식은
서로 독립적이며, extension의 기존 API 요청만 CORS 허용됩니다. extension ID가 바뀌면 같은
`--with-extension` setup을 다시 실행한 뒤 API를 재시작하세요.

동결 범위와 코드 경계는 [`extension/FROZEN.md`](../extension/FROZEN.md)를 참고하세요.
