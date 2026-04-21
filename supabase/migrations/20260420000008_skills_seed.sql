-- Migration: seed curated skills catalog (ADR-013 §4)
-- Depends on: 20260420000000_skills_catalog
-- Ref: docs/adr/adr-013-skills-taxonomy.md §4, src/lib/skills/seed.ts
-- Rollback:
--   delete from skill_aliases where source = 'seed';
--   delete from skills where slug in (<slugs listed below>);
--
-- Source of truth: src/lib/skills/seed.ts. A sanity test
-- (tests/integration/skills/seed.test.ts) checks that the row
-- counts and slug set in the DB match the TS array, so drift
-- either direction is caught immediately.

-- ────────────────────────────────────────────────────────────────
-- 1. Skills (canonical list)
-- ────────────────────────────────────────────────────────────────
insert into skills (canonical_name, slug, category) values
  ('TypeScript',      'typescript',      'language'),
  ('JavaScript',      'javascript',      'language'),
  ('Python',          'python',          'language'),
  ('Java',            'java',            'language'),
  ('Kotlin',          'kotlin',          'language'),
  ('Go',              'go',              'language'),
  ('Rust',            'rust',            'language'),
  ('Ruby',            'ruby',            'language'),
  ('PHP',             'php',             'language'),
  ('C#',              'c#',              'language'),
  ('C++',             'c++',             'language'),
  ('Swift',           'swift',           'language'),
  ('Scala',           'scala',           'language'),
  ('Elixir',          'elixir',          'language'),
  ('SQL',             'sql',             'language'),
  ('React',           'react',           'framework'),
  ('Next.js',         'next.js',         'framework'),
  ('Vue.js',          'vue.js',          'framework'),
  ('Angular',         'angular',         'framework'),
  ('Svelte',          'svelte',          'framework'),
  ('React Native',    'react native',    'framework'),
  ('Express',         'express',         'framework'),
  ('NestJS',          'nestjs',          'framework'),
  ('Django',          'django',          'framework'),
  ('Flask',           'flask',           'framework'),
  ('FastAPI',         'fastapi',         'framework'),
  ('Ruby on Rails',   'ruby on rails',   'framework'),
  ('Spring Boot',     'spring boot',     'framework'),
  ('Laravel',         'laravel',         'framework'),
  ('.NET',            '.net',            'framework'),
  ('Node.js',         'node.js',         'runtime'),
  ('Deno',            'deno',            'runtime'),
  ('Bun',             'bun',             'runtime'),
  ('PostgreSQL',      'postgresql',      'database'),
  ('MySQL',           'mysql',           'database'),
  ('MongoDB',         'mongodb',         'database'),
  ('Redis',           'redis',           'database'),
  ('DynamoDB',        'dynamodb',        'database'),
  ('Elasticsearch',   'elasticsearch',   'database'),
  ('SQLite',          'sqlite',          'database'),
  ('AWS',             'aws',             'cloud'),
  ('GCP',             'gcp',             'cloud'),
  ('Azure',           'azure',           'cloud'),
  ('Vercel',          'vercel',          'cloud'),
  ('Supabase',        'supabase',        'cloud'),
  ('Firebase',        'firebase',        'cloud'),
  ('Heroku',          'heroku',          'cloud'),
  ('Docker',          'docker',          'devops'),
  ('Kubernetes',      'kubernetes',      'devops'),
  ('Terraform',       'terraform',       'devops'),
  ('Ansible',         'ansible',         'devops'),
  ('CI/CD',           'ci/cd',           'devops'),
  ('GitHub Actions',  'github actions',  'devops'),
  ('GitLab CI',       'gitlab ci',       'devops'),
  ('Jenkins',         'jenkins',         'devops'),
  ('Git',             'git',             'tool'),
  ('Linux',           'linux',           'platform'),
  ('GraphQL',         'graphql',         'tool'),
  ('REST',            'rest',            'practice'),
  ('gRPC',            'grpc',            'tool'),
  ('Kafka',           'kafka',           'tool'),
  ('RabbitMQ',        'rabbitmq',        'tool'),
  ('Tailwind CSS',    'tailwind css',    'framework'),
  ('Prisma',          'prisma',          'library'),
  ('pgvector',        'pgvector',        'tool');

-- ────────────────────────────────────────────────────────────────
-- 2. Aliases (source='seed')
-- ────────────────────────────────────────────────────────────────
-- alias_normalized strings must already be in post-normalization
-- form: lowercase, collapsed whitespace, no terminal punctuation.
-- See src/lib/skills/resolver.ts::normalizeSkillInput.
insert into skill_aliases (skill_id, alias_normalized, source)
select s.id, a.alias_normalized, 'seed'
from skills s
join (values
  ('typescript',      'ts'),
  ('javascript',      'js'),
  ('javascript',      'ecmascript'),
  ('javascript',      'es6'),
  ('javascript',      'es2015'),
  ('python',          'python3'),
  ('python',          'py'),
  ('go',              'golang'),
  ('c#',              'csharp'),
  ('c#',              'c-sharp'),
  ('c++',             'cpp'),
  ('c++',             'cplusplus'),
  ('react',           'react.js'),
  ('react',           'reactjs'),
  ('next.js',         'nextjs'),
  ('next.js',         'next'),
  ('vue.js',          'vue'),
  ('vue.js',          'vuejs'),
  ('angular',         'angular 2+'),
  ('angular',         'angularjs'),
  ('svelte',          'sveltekit'),
  ('react native',    'rn'),
  ('express',         'express.js'),
  ('express',         'expressjs'),
  ('nestjs',          'nest.js'),
  ('nestjs',          'nest'),
  ('ruby on rails',   'rails'),
  ('ruby on rails',   'ror'),
  ('spring boot',     'spring'),
  ('spring boot',     'springboot'),
  ('.net',            'dotnet'),
  ('.net',            '.net core'),
  ('.net',            'dot net'),
  ('node.js',         'node'),
  ('node.js',         'nodejs'),
  ('postgresql',      'postgres'),
  ('postgresql',      'psql'),
  ('mongodb',         'mongo'),
  ('elasticsearch',   'elastic'),
  ('elasticsearch',   'es'),
  ('aws',             'amazon web services'),
  ('gcp',             'google cloud'),
  ('gcp',             'google cloud platform'),
  ('azure',           'microsoft azure'),
  ('kubernetes',      'k8s'),
  ('ci/cd',           'cicd'),
  ('ci/cd',           'ci-cd'),
  ('ci/cd',           'continuous integration'),
  ('ci/cd',           'continuous delivery'),
  ('gitlab ci',       'gitlab-ci'),
  ('rest',            'rest api'),
  ('rest',            'restful'),
  ('rest',            'restful api'),
  ('kafka',           'apache kafka'),
  ('tailwind css',    'tailwind'),
  ('tailwind css',    'tailwindcss')
) as a(slug, alias_normalized) on s.slug = a.slug;
