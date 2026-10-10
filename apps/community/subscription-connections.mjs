// Public onboarding metadata only. Authentication belongs to the official CLI/Gateway.
export const VERIFIED_OPENCLAW_AUTH = Object.freeze({
  '2026.3.13': 'openai-codex',
  '2026.3.13-1': 'openai-codex',
  '2026.9.5': 'openai',
});

export const SUBSCRIPTION_CONNECTIONS = Object.freeze([
  {
    id: 'codex', name: 'ChatGPT · Codex', status: 'gateway_login',
    description: '공식 Codex 기기 로그인 또는 OpenClaw Gateway OAuth로 연결합니다. CLI 로그인만으로 이 앱이 연결되지는 않습니다.',
    docsUrl: 'https://developers.openai.com/codex/auth/',
    gatewayDocsUrl: 'https://docs.openclaw.ai/providers/openai',
    command: 'node apps/community/scripts/connect-subscription.mjs codex --check',
    steps: [
      '앱 설치 후 Gateway 구독 설정과 비공개 영구 저장소를 준비합니다.',
      'Gateway가 있는 서버 터미널에서 helper의 --gateway compose 또는 --gateway local 경로로 로그인합니다.',
      '공식 화면에서 승인하면 Gateway가 인증을 저장하고 추천 모델을 선택합니다. 앱에서 Gateway 연결을 선택하세요.',
      '공식 Codex CLI만 사용할 때는 helper를 gateway 옵션 없이 실행합니다. 기기 코드는 본인 터미널에서만 사용하세요.',
    ],
    gatewaySupported: true,
    verifiedGatewayVersions: Object.keys(VERIFIED_OPENCLAW_AUTH),
    billing: 'ChatGPT 계정의 Codex 이용 권한과 사용 한도가 적용됩니다. API 크레딧과 별개입니다.',
  },
  {
    id: 'claude', name: 'Claude Code', status: 'cli_only',
    description: '공식 Claude Code CLI 로그인만 지원합니다. 이 앱의 Claude 모델 연결은 별도 API 키를 사용합니다.',
    docsUrl: 'https://code.claude.com/docs/en/authentication',
    command: 'node apps/community/scripts/connect-subscription.mjs claude --check',
    steps: [
      '서버에 공식 Claude Code CLI를 설치하고 helper를 실행합니다.',
      '공식 로그인 화면에서 본인 계정으로 로그인합니다.',
      '로그인 정보는 Claude Code가 보관합니다. 이 앱이나 Gateway로 구독 토큰을 복사하지 않습니다.',
    ],
    gatewaySupported: false,
    billing: 'Claude Code의 구독 사용량과 Anthropic API 요금은 별개입니다.',
  },
  {
    id: 'gemini', name: 'Gemini CLI', status: 'cli_only',
    description: '공식 Gemini CLI의 Google 로그인만 지원합니다. 이 앱의 Gemini 연결은 별도 API 키를 사용합니다.',
    docsUrl: 'https://geminicli.com/docs/get-started/authentication/',
    command: 'node apps/community/scripts/connect-subscription.mjs gemini --check',
    steps: [
      '서버에 공식 Gemini CLI를 설치하고 helper를 실행합니다.',
      'Sign in with Google을 선택하고 이용할 구독의 Google 계정으로 로그인합니다.',
      '로그인 상태는 Gemini CLI가 보관합니다. 비공식 Gateway OAuth 플러그인은 활성화하지 않습니다.',
    ],
    gatewaySupported: false,
    billing: 'Google 계정의 Gemini CLI 이용 한도가 적용됩니다. Gemini API 키 요금과 별개입니다.',
  },
].map((entry) => Object.freeze({...entry, steps: Object.freeze(entry.steps)})));

export function getSubscriptionConnections({gatewayVersion} = {}) {
  return SUBSCRIPTION_CONNECTIONS.map((entry) => ({
    ...entry, steps: [...entry.steps],
    ...(entry.id === 'codex' && gatewayVersion ? {
      gatewayVersionVerified: Object.hasOwn(VERIFIED_OPENCLAW_AUTH, gatewayVersion),
    } : {}),
  }));
}
