import dotenv from 'dotenv';

dotenv.config();

const HEX_64 = /^[a-fA-F0-9]{64}$/;

const checks = [
  {
    key: 'DATABASE_URL',
    level: 'required',
    purpose: 'Postgres connection',
    validator: (v) => (v.startsWith('postgresql://') || v.startsWith('postgres://'))
      ? null
      : 'must start with postgresql:// or postgres://',
  },
  {
    key: 'REDIS_URL',
    level: 'required',
    purpose: 'Redis connection',
    validator: (v) => v.startsWith('redis://')
      ? null
      : 'must start with redis://',
  },
  {
    key: 'ANTHROPIC_API_KEY',
    level: 'optional',
    purpose: 'Anthropic provider',
  },
  {
    key: 'OPENAI_API_KEY',
    level: 'optional',
    purpose: 'OpenAI provider',
  },
  {
    key: 'BRAVE_SEARCH_API_KEY',
    level: 'optional',
    purpose: 'Web research / auto-learning',
  },
  {
    key: 'KILO_CREDENTIAL_KEY',
    level: 'optional',
    purpose: 'Tool credential encryption',
    validator: (v) => HEX_64.test(v)
      ? null
      : 'must be a 64-character hex string',
  },
];

function statusOf(value) {
  return value && value.trim().length > 0 ? 'set' : 'missing';
}

let hasErrors = false;

console.log('Environment validation (values redacted):');
for (const check of checks) {
  const raw = process.env[check.key];
  const status = statusOf(raw);
  const label = check.level === 'required' ? 'REQUIRED' : 'OPTIONAL';
  if (status === 'missing') {
    console.log(`- [${label}] ${check.key}: missing (${check.purpose})`);
    if (check.level === 'required') hasErrors = true;
    continue;
  }

  let validationIssue = null;
  if (check.validator) {
    validationIssue = check.validator(raw);
  }

  if (validationIssue) {
    console.log(`- [${label}] ${check.key}: invalid (${validationIssue})`);
    if (check.level === 'required' || check.key === 'KILO_CREDENTIAL_KEY') {
      hasErrors = true;
    }
  } else {
    console.log(`- [${label}] ${check.key}: set (${check.purpose})`);
  }
}

const hasAnthropic = statusOf(process.env.ANTHROPIC_API_KEY) === 'set';
const hasOpenAI = statusOf(process.env.OPENAI_API_KEY) === 'set';
if (!hasAnthropic && !hasOpenAI) {
  console.log('- [REQUIRED] LLM provider: missing (set ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  hasErrors = true;
}

if (hasErrors) {
  console.error('\nEnvironment check failed.');
  process.exit(1);
}

console.log('\nEnvironment check passed.');
