# 관리자 연결 서비스

`/integrations`에서 사이트 관리자만 개인 서비스 연결을 조회한다. 개인 메일/캘린더 응답은 공동 방 메시지에 전달하지 않는다. 관리자 전용 질문창에서 요청한 조회 결과만 모델 프롬프트에 전달하며, 응답은 DB에 저장하지 않는다. 모든 실행 API는 로그인, 관리자 역할, 동일 출처, CSRF 검증을 거친다. 브라우저나 데스크톱 컨테이너에는 자격 증명을 전달하지 않는다.

## 저장/배포

모델 키는 서버의 `apps/community/deploy/.env.providers`(0600)에 보관한다. Compose 선택적 env_file로 앱에만 전달한다. 개인 연결은 데이터 볼륨의 `/data/private-integrations.json`(1000:1000,0600)에 보관하며 `COMMUNITY_INTEGRATIONS_FILE`로 지정한다. 두 파일 모두 Git, 이미지, 빌드 컨텍스트 밖에 둔다. 기존 파일은 교체 전에 백업한다. 원본 로컬 AGY 보관소는 수정하지 않는다.

## 모델

Groq, Gemini, Hugging Face, NVIDIA NIM, Cohere, OpenRouter 및 기존 OpenAI/xAI 호환 연결. 번호가 붙은 키를 모두 읽고 동일 키를 중복 제거한다. Gemini 모델 목록의 `models/` 접두사를 정규화한다. 자동 모드는 공급자별 모델을 선택하고 OpenRouter는 `:free` 모델만 선택한다. 모델을 지정하면 해당 모델이 있는 공급자/키만 시도한다.

401/402/403/404/408/429/5xx 및 연결/시간 초과 시 최대 8회 내에서 다른 공급자를 먼저 시도한다. 추가 시도도 사용량 제한에 포함된다. 실패한 키에는 프로세스 내 cooldown이 적용된다. 이미 실행된 브라우저 도구는 재실행하지 않는다. 요청 취소 및 일반 400 오류는 재시도하지 않는다. 재시작하면 cooldown은 초기화된다. 모델 목록 조회 성공은 키 인증/잔여 한도의 증거가 아니므로 실제 응답을 별도로 검증한다.

## 개인 서비스 범위

- 네이버 메일: SSL IMAP, 읽기 전용 INBOX, 최근 20개 제목/보낸사람/날짜. 읽음 표시 변경·발송 없음.
- 카카오: 캘린더 목록, 토큰 갱신 및 새 토큰 원자적 보관. `talk_calendar` 동의와 유효한 refresh token 필요.
- Meta: 공식 Graph API 앱 또는 사용자/페이지 프로필. 앱 토큰만 있으면 앱 인증까지만 가능. 브라우저 쿠키/비공개 API 우회 없음.
- Tavily: 관리자 검색, 최대 5개 결과.
- ElevenLabs: 음성 목록; 번호 키 재시도.
- Replicate: 계정 확인.
- Firecrawl: 잔여 크레딧; 번호 키 재시도.
- Resend: 등록 도메인 조회.
- Cloudinary: 이미지 메타데이터 목록.
- Telegram: 봇 프로필 확인. 메시지 발송/업데이트 소비/웹훅 변경 없음.
- Cohere: 모델 목록 및 대화 모델 풀.
- Naver Commerce: bcrypt 서명 기반 서버 인증 확인. 토큰 값은 반환하지 않는다.
- Fal: 모델 목록 조회. 생성·결제 호출 없음.
- Jina: 검색 결과 최대 5개 조회.

클라우드/DB 관리키(OCI, Cloudflare, Vercel, GitHub, Turso, Supabase 등)를 공동 대화에 일괄 주입하지 않는다. 서비스 실행에 필요한 최소 인증 정보만 관리자 연결 저장소에 넣는다.

## 공식 API 참고

- https://developers.kakao.com/docs/ko/talkcalendar/rest-api
- https://help.naver.com/service/30029/contents/21351?osType=COMMONOS
- https://huggingface.co/docs/inference-providers/en/index
- https://docs.cohere.com/docs/compatibility-api
- https://docs.firecrawl.dev/api-reference/endpoint/credit-usage
- https://resend.com/docs/api-reference/domains/list-domains
- https://cloudinary.com/documentation/admin_api
- https://core.telegram.org/bots/api#getme
