# OpenGrokbot 사용자 커뮤니티 앱

이 작업은 [Open-Grokbot upstream](https://github.com/LING71671/open-grokbot)의 GPL-3.0-only clean-room 프레임워크를 기반으로, 초대 기반 사용자 커뮤니티 웹앱을 별도 구현한 사례다. upstream 프레임워크 자체를 처음부터 만들었다고 주장하지 않으며, 아래의 제품 표면과 운영 경계를 구현·검증하는 데 기여했다.

- 초대 전용 가입, scrypt 비밀번호 해시, HttpOnly 세션, CSRF 방어와 관리자 초대 흐름
- 방별 멤버 ACL, 메시지·초대·첨부 접근 제어, 일일 사용자·전역 quota
- 이미지·음성 파일의 크기·MIME·서명 검증과 미게시 첨부의 업로더 전용 접근
- Docker/OCI 배포 구성과 서버 측 방별 데스크톱 map, 티켓 기반 same-origin WebSocket 프록시
- 제한된 브라우저 도구 루프와 OpenAI 호환 모델 adapter, OpenClaw 2.0 계열 gateway adapter의 server-only 환경 변수 연결

외부 LLM 비용 없이 사람 간 대화만 실행할 수 있으며 provider/API key는 저장소에 포함하지 않는다. 이미지 인식과 음성 전사는 구현하지 않았고, 방별 데스크톱은 운영자의 수동 provision이 필요하다. OpenClaw adapter는 환경 변수로 명시적으로 활성화되지만 현재 별도 gateway 연결 작업 중이므로 최종 운영 검증 전에는 실서비스 동작을 보장하지 않는다.

검증 명령은 `npm test -w @open-grokbot/community`이며, 테스트는 인증·방 ACL·초대·첨부·데스크톱 티켓/프록시·모델 도구 루프를 대상으로 한다. 공개 URL의 부하·장기 운영 검증 결과를 성과로 주장하지 않는다.

라이선스는 저장소의 [GPL-3.0-only LICENSE](../LICENSE)를 따르며, 원본 제품의 소스·자산·비공개 자격 증명을 포함하지 않는다.
