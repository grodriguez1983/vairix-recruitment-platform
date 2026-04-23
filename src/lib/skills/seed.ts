/**
 * Curated skills seed (ADR-013 §4) — source of truth.
 *
 * This array is the canonical reference for the seed migration
 * (`supabase/migrations/20260420000008_skills_seed.sql`). The
 * migration reproduces these rows verbatim; if the two diverge we
 * prefer this file and regenerate the SQL.
 *
 * Rationale for curation choices:
 *
 * - Slugs follow the ADR-013 §2 normalization rules: lowercase,
 *   internal punctuation preserved (`node.js`, `c++`, `c#`,
 *   `ci/cd`), whitespace-to-single-space. Terminal punctuation is
 *   never part of a slug.
 * - Aliases cover the common variants we expect in CVs scraped
 *   mix-ES/EN (e.g. `"react.js"`, `"reactjs"`, `"React"`).
 * - No hierarchy: "React" is not a child of "JavaScript". Category
 *   is a flat tag for UI grouping, never for scoring.
 * - Deprecated-at is null in this seed; admins mark obsolete
 *   skills through the /admin/skills UI later (ADR-013 §5).
 *
 * Derived aliases (ADR-013 §4 second migration) are NOT included
 * here — they land in a separate file once we have real extraction
 * data to mine.
 *
 * Invariants enforced by the migration:
 *   - `slug` unique globally.
 *   - `alias_normalized` unique globally (skill_aliases).
 *   - No alias duplicates a slug from a DIFFERENT skill (the
 *     resolver prefers slug over alias, but allowing such a clash
 *     is a data-quality smell).
 */

export type SeedAlias = string;

export type SeedSkill = {
  canonical_name: string;
  slug: string;
  category: SkillCategory;
  aliases: SeedAlias[];
};

export type SkillCategory =
  | 'language'
  | 'framework'
  | 'library'
  | 'runtime'
  | 'database'
  | 'cloud'
  | 'devops'
  | 'tool'
  | 'platform'
  | 'practice';

/**
 * Canonical skills + aliases. Keep alphabetized within each
 * category block. ~60 skills total — the high-frequency tech
 * recruiting core for VAIRIX (ADR-013 §4).
 */
export const CURATED_SKILLS: readonly SeedSkill[] = [
  // ──────────────────────────────────────────────────────────────
  // Languages
  // ──────────────────────────────────────────────────────────────
  {
    canonical_name: 'TypeScript',
    slug: 'typescript',
    category: 'language',
    aliases: ['ts'],
  },
  {
    canonical_name: 'JavaScript',
    slug: 'javascript',
    category: 'language',
    aliases: ['js', 'ecmascript', 'es6', 'es2015'],
  },
  {
    canonical_name: 'Python',
    slug: 'python',
    category: 'language',
    aliases: ['python3', 'py'],
  },
  {
    canonical_name: 'Java',
    slug: 'java',
    category: 'language',
    aliases: [],
  },
  {
    canonical_name: 'Kotlin',
    slug: 'kotlin',
    category: 'language',
    aliases: [],
  },
  {
    canonical_name: 'Go',
    slug: 'go',
    category: 'language',
    aliases: ['golang'],
  },
  {
    canonical_name: 'Rust',
    slug: 'rust',
    category: 'language',
    aliases: [],
  },
  {
    canonical_name: 'Ruby',
    slug: 'ruby',
    category: 'language',
    aliases: [],
  },
  {
    canonical_name: 'PHP',
    slug: 'php',
    category: 'language',
    aliases: [],
  },
  {
    canonical_name: 'C#',
    slug: 'c#',
    category: 'language',
    aliases: ['csharp', 'c sharp'],
  },
  {
    canonical_name: 'C++',
    slug: 'c++',
    category: 'language',
    aliases: ['cpp', 'cplusplus'],
  },
  {
    canonical_name: 'Swift',
    slug: 'swift',
    category: 'language',
    aliases: [],
  },
  {
    canonical_name: 'Scala',
    slug: 'scala',
    category: 'language',
    aliases: [],
  },
  {
    canonical_name: 'Elixir',
    slug: 'elixir',
    category: 'language',
    aliases: [],
  },
  {
    canonical_name: 'SQL',
    slug: 'sql',
    category: 'language',
    aliases: [],
  },

  // ──────────────────────────────────────────────────────────────
  // Frameworks / libraries (frontend + backend)
  // ──────────────────────────────────────────────────────────────
  {
    canonical_name: 'React',
    slug: 'react',
    category: 'framework',
    aliases: ['react.js', 'reactjs'],
  },
  {
    canonical_name: 'Next.js',
    slug: 'next.js',
    category: 'framework',
    aliases: ['nextjs', 'next'],
  },
  {
    canonical_name: 'Vue.js',
    slug: 'vue.js',
    category: 'framework',
    aliases: ['vue', 'vuejs'],
  },
  {
    canonical_name: 'Angular',
    slug: 'angular',
    category: 'framework',
    aliases: ['angular 2+', 'angularjs'],
  },
  {
    canonical_name: 'Svelte',
    slug: 'svelte',
    category: 'framework',
    aliases: ['sveltekit'],
  },
  {
    canonical_name: 'React Native',
    slug: 'react native',
    category: 'framework',
    aliases: ['rn'],
  },
  {
    canonical_name: 'Express',
    slug: 'express',
    category: 'framework',
    aliases: ['express.js', 'expressjs'],
  },
  {
    canonical_name: 'NestJS',
    slug: 'nestjs',
    category: 'framework',
    aliases: ['nest.js', 'nest'],
  },
  {
    canonical_name: 'Django',
    slug: 'django',
    category: 'framework',
    aliases: [],
  },
  {
    canonical_name: 'Flask',
    slug: 'flask',
    category: 'framework',
    aliases: [],
  },
  {
    canonical_name: 'FastAPI',
    slug: 'fastapi',
    category: 'framework',
    aliases: [],
  },
  {
    canonical_name: 'Ruby on Rails',
    slug: 'ruby on rails',
    category: 'framework',
    aliases: ['rails', 'ror'],
  },
  {
    canonical_name: 'Spring Boot',
    slug: 'spring boot',
    category: 'framework',
    aliases: ['spring', 'springboot'],
  },
  {
    canonical_name: 'Laravel',
    slug: 'laravel',
    category: 'framework',
    aliases: [],
  },
  {
    canonical_name: '.NET',
    slug: '.net',
    category: 'framework',
    aliases: ['dotnet', '.net core', 'dot net'],
  },

  // ──────────────────────────────────────────────────────────────
  // Runtimes
  // ──────────────────────────────────────────────────────────────
  {
    canonical_name: 'Node.js',
    slug: 'node.js',
    category: 'runtime',
    aliases: ['node', 'nodejs'],
  },
  {
    canonical_name: 'Deno',
    slug: 'deno',
    category: 'runtime',
    aliases: [],
  },
  {
    canonical_name: 'Bun',
    slug: 'bun',
    category: 'runtime',
    aliases: [],
  },

  // ──────────────────────────────────────────────────────────────
  // Databases
  // ──────────────────────────────────────────────────────────────
  {
    canonical_name: 'PostgreSQL',
    slug: 'postgresql',
    category: 'database',
    aliases: ['postgres', 'psql'],
  },
  {
    canonical_name: 'MySQL',
    slug: 'mysql',
    category: 'database',
    aliases: [],
  },
  {
    canonical_name: 'MongoDB',
    slug: 'mongodb',
    category: 'database',
    aliases: ['mongo'],
  },
  {
    canonical_name: 'Redis',
    slug: 'redis',
    category: 'database',
    aliases: [],
  },
  {
    canonical_name: 'DynamoDB',
    slug: 'dynamodb',
    category: 'database',
    aliases: [],
  },
  {
    canonical_name: 'Elasticsearch',
    slug: 'elasticsearch',
    category: 'database',
    aliases: ['elastic', 'es'],
  },
  {
    canonical_name: 'SQLite',
    slug: 'sqlite',
    category: 'database',
    aliases: [],
  },

  // ──────────────────────────────────────────────────────────────
  // Cloud
  // ──────────────────────────────────────────────────────────────
  {
    canonical_name: 'AWS',
    slug: 'aws',
    category: 'cloud',
    aliases: ['amazon web services'],
  },
  {
    canonical_name: 'GCP',
    slug: 'gcp',
    category: 'cloud',
    aliases: ['google cloud', 'google cloud platform'],
  },
  {
    canonical_name: 'Azure',
    slug: 'azure',
    category: 'cloud',
    aliases: ['microsoft azure'],
  },
  {
    canonical_name: 'Vercel',
    slug: 'vercel',
    category: 'cloud',
    aliases: [],
  },
  {
    canonical_name: 'Supabase',
    slug: 'supabase',
    category: 'cloud',
    aliases: [],
  },
  {
    canonical_name: 'Firebase',
    slug: 'firebase',
    category: 'cloud',
    aliases: [],
  },
  {
    canonical_name: 'Heroku',
    slug: 'heroku',
    category: 'cloud',
    aliases: [],
  },

  // ──────────────────────────────────────────────────────────────
  // DevOps / tooling / platform
  // ──────────────────────────────────────────────────────────────
  {
    canonical_name: 'Docker',
    slug: 'docker',
    category: 'devops',
    aliases: [],
  },
  {
    canonical_name: 'Kubernetes',
    slug: 'kubernetes',
    category: 'devops',
    aliases: ['k8s'],
  },
  {
    canonical_name: 'Terraform',
    slug: 'terraform',
    category: 'devops',
    aliases: [],
  },
  {
    canonical_name: 'Ansible',
    slug: 'ansible',
    category: 'devops',
    aliases: [],
  },
  {
    canonical_name: 'CI/CD',
    slug: 'ci/cd',
    category: 'devops',
    aliases: ['cicd', 'ci cd', 'continuous integration', 'continuous delivery'],
  },
  {
    canonical_name: 'GitHub Actions',
    slug: 'github actions',
    category: 'devops',
    aliases: [],
  },
  {
    canonical_name: 'GitLab CI',
    slug: 'gitlab ci',
    category: 'devops',
    aliases: ['gitlab ci'],
  },
  {
    canonical_name: 'Jenkins',
    slug: 'jenkins',
    category: 'devops',
    aliases: [],
  },
  {
    canonical_name: 'Git',
    slug: 'git',
    category: 'tool',
    aliases: [],
  },
  {
    canonical_name: 'Linux',
    slug: 'linux',
    category: 'platform',
    aliases: [],
  },
  {
    canonical_name: 'GraphQL',
    slug: 'graphql',
    category: 'tool',
    aliases: [],
  },
  {
    canonical_name: 'REST',
    slug: 'rest',
    category: 'practice',
    aliases: ['rest api', 'restful', 'restful api'],
  },
  {
    canonical_name: 'gRPC',
    slug: 'grpc',
    category: 'tool',
    aliases: [],
  },
  {
    canonical_name: 'Kafka',
    slug: 'kafka',
    category: 'tool',
    aliases: ['apache kafka'],
  },
  {
    canonical_name: 'RabbitMQ',
    slug: 'rabbitmq',
    category: 'tool',
    aliases: [],
  },
  {
    canonical_name: 'Tailwind CSS',
    slug: 'tailwind css',
    category: 'framework',
    aliases: ['tailwind', 'tailwindcss'],
  },
  {
    canonical_name: 'Prisma',
    slug: 'prisma',
    category: 'library',
    aliases: [],
  },
  {
    canonical_name: 'pgvector',
    slug: 'pgvector',
    category: 'tool',
    aliases: [],
  },
];
