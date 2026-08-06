import { normalizeForMatch } from "../text.js";

/**
 * Curated tech alias families (spec 003 §FR-7, T3.2): the deterministic
 * matching pre-pass resolves exact/alias-normalized skill overlap without an
 * LLM call. Each group's FIRST entry is the canonical form; every other entry
 * folds onto it. Pure data + pure functions — extend by adding a group or an
 * alias, never by special-casing callers.
 *
 * Two invariants (asserted in aliases.spec.ts):
 *  - no alias string may appear in two families with different canonicals;
 *  - canonicalization is idempotent: canonical(canonical(x)) === canonical(x).
 */

/** Alias families; first member is canonical. All entries are pre-normalized. */
const ALIAS_GROUPS: readonly (readonly string[])[] = [
  // Programming languages
  ["javascript", "js", "ecmascript"],
  ["typescript", "ts"],
  ["python", "py", "python3"],
  ["golang", "go"],
  ["c++", "cpp"],
  ["c#", "csharp", "c sharp"],
  ["objective-c", "objc"],
  ["ruby on rails", "rails", "ror"],
  ["visual basic", "vb", "vb.net"],
  // Frontend
  ["react", "reactjs", "react.js"],
  ["react native", "reactnative"],
  ["angular", "angularjs", "angular.js"],
  ["vue.js", "vue", "vuejs"],
  ["svelte", "sveltejs"],
  ["next.js", "nextjs", "next"],
  ["nuxt", "nuxtjs", "nuxt.js"],
  ["jquery"],
  ["html", "html5"],
  ["css", "css3"],
  ["sass", "scss"],
  ["tailwind css", "tailwind", "tailwindcss"],
  ["webpack"],
  ["vite"],
  // Backend / runtimes / frameworks
  ["node.js", "node", "nodejs"],
  ["express", "expressjs", "express.js"],
  ["nestjs", "nest", "nest.js"],
  ["django"],
  ["flask"],
  ["fastapi", "fast api"],
  ["spring boot", "springboot"],
  ["spring", "spring framework"],
  [".net", "dotnet", "dot net"],
  ["asp.net", "asp net"],
  ["laravel"],
  ["symfony"],
  // Data stores
  ["postgresql", "postgres", "psql", "pg"],
  ["mysql"],
  ["mariadb", "maria db"],
  ["sqlite"],
  ["mongodb", "mongo"],
  ["redis"],
  ["memcached"],
  ["elasticsearch", "elastic search"],
  ["dynamodb", "dynamo db"],
  ["cassandra", "apache cassandra"],
  ["sql server", "mssql", "microsoft sql server", "ms sql"],
  ["oracle", "oracle database", "oracle db"],
  ["bigquery", "big query"],
  ["snowflake"],
  ["redshift", "amazon redshift"],
  ["supabase"],
  // Cloud platforms
  ["amazon web services", "aws"],
  ["google cloud platform", "google cloud", "gcp"],
  ["microsoft azure", "azure"],
  ["firebase", "google firebase"],
  ["s3", "aws s3", "amazon s3"],
  ["ec2", "aws ec2", "amazon ec2"],
  ["cloudformation", "aws cloudformation"],
  // DevOps / tooling
  ["kubernetes", "k8s"],
  ["openshift", "red hat openshift"],
  ["docker"],
  ["docker compose", "docker-compose"],
  ["terraform"],
  ["ansible"],
  ["jenkins"],
  ["github actions", "gh actions"],
  ["gitlab ci", "gitlab-ci"],
  ["ci/cd", "cicd", "ci cd", "continuous integration"],
  ["helm"],
  ["prometheus"],
  ["grafana"],
  ["datadog"],
  ["new relic", "newrelic"],
  ["splunk"],
  ["linux"],
  ["git"],
  ["bash", "shell scripting"],
  ["powershell"],
  // Messaging / data engineering
  ["apache kafka", "kafka"],
  ["rabbitmq", "rabbit mq"],
  ["apache spark", "spark"],
  ["apache airflow", "airflow"],
  ["apache hadoop", "hadoop"],
  ["dbt"],
  // ML / AI
  ["machine learning", "ml"],
  ["deep learning", "dl"],
  ["artificial intelligence", "ai"],
  ["natural language processing", "nlp"],
  ["large language model", "llm"],
  ["tensorflow", "tf"],
  ["pytorch", "py torch"],
  ["scikit-learn", "sklearn"],
  // APIs / architecture / practices
  ["graphql", "graph ql"],
  ["rest", "rest api", "restful", "restful api"],
  ["grpc"],
  ["microservices", "micro services", "microservice"],
  ["oauth", "oauth2", "oauth 2.0"],
  ["jwt", "json web token", "json web tokens"],
  ["openapi", "swagger"],
  ["websockets", "web sockets", "websocket"],
  ["tdd", "test-driven development", "test driven development"],
  ["bdd", "behavior-driven development", "behaviour-driven development"],
  ["devops", "dev ops"],
  ["sre", "site reliability engineering", "site reliability engineer"],
  ["scrum"],
  ["agile", "agile methodology"],
  ["kanban"],
  ["seo", "search engine optimization"],
  // Testing
  ["jest"],
  ["cypress"],
  ["playwright"],
  ["selenium"],
  ["unit testing", "unit tests"],
];

function buildAliasMap(): Record<string, string> {
  const map: Record<string, string> = {};
  for (const group of ALIAS_GROUPS) {
    const canonicalRaw = group[0];
    if (canonicalRaw === undefined) continue;
    const canonical = normalizeForMatch(canonicalRaw);
    for (const alias of group) {
      const key = normalizeForMatch(alias);
      const existing = map[key];
      if (existing !== undefined && existing !== canonical) {
        throw new Error(`alias "${key}" maps to both "${existing}" and "${canonical}"`);
      }
      map[key] = canonical;
    }
  }
  return map;
}

/**
 * Normalized-alias → canonical lookup. Keys and values are already
 * normalizeForMatch-folded, so lookups must canonicalize their input first
 * (use canonicalizeSkill / canonicalizePhrase, not this map directly).
 */
export const TECH_ALIASES: Readonly<Record<string, string>> = buildAliasMap();

/** Fold a single skill/technology name to its canonical alias form. */
export function canonicalizeSkill(input: string): string {
  const normalized = normalizeForMatch(input);
  return TECH_ALIASES[normalized] ?? normalized;
}

/** Longest alias key we try when folding phrases (kept small on purpose). */
const MAX_GRAM = 4;

/**
 * Fold every alias known inside a free-text phrase (requirement text, skill
 * list entry) to canonical form, longest-match first. Tokens without an alias
 * pass through unchanged. Idempotent and deterministic.
 */
export function canonicalizePhrase(text: string): string {
  const normalized = normalizeForMatch(text);
  const direct = TECH_ALIASES[normalized];
  if (direct !== undefined) return direct;
  const tokens = normalized.split(" ").filter((t) => t.length > 0);
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    let consumed = 0;
    const maxLen = Math.min(MAX_GRAM, tokens.length - i);
    for (let len = maxLen; len >= 1; len--) {
      const gram = tokens.slice(i, i + len).join(" ");
      const canonical = TECH_ALIASES[gram];
      if (canonical !== undefined) {
        out.push(canonical);
        consumed = len;
        break;
      }
    }
    if (consumed === 0) {
      const token = tokens[i];
      if (token !== undefined) out.push(token);
      consumed = 1;
    }
    i += consumed;
  }
  return out.join(" ");
}
