import { OUTPUT_CLASH_DIR, OUTPUT_SINGBOX_DIR, OUTPUT_SURGE_DIR } from '../../constants/dir';
import type { Span } from '../../trace';
import { createTrie } from '../trie';
import stringify from 'json-stringify-pretty-compact';
import path from 'node:path';
import { withBannerArray } from '../misc';
import { invariant } from 'foxact/invariant';
import picocolors from 'picocolors';
import fs from 'node:fs';
import { fastStringArrayJoin, writeFile } from '../misc';
import { readFileByLine } from '../fetch-text-by-line';
import { asyncWriteToStream } from '../async-write-to-stream';

export abstract class RuleOutput {
  protected domainTrie = createTrie<unknown>(null, true);
  protected domainKeywords = new Set<string>();
  protected domainWildcard = new Set<string>();
  protected userAgent = new Set<string>();
  protected processName = new Set<string>();
  protected processPath = new Set<string>();
  protected urlRegex = new Set<string>();
  protected ipcidr = new Set<string>();
  protected ipcidrNoResolve = new Set<string>();
  protected ipasn = new Set<string>();
  protected ipasnNoResolve = new Set<string>();
  protected ipcidr6 = new Set<string>();
  protected ipcidr6NoResolve = new Set<string>();
  protected geoip = new Set<string>();
  protected groipNoResolve = new Set<string>();
  // TODO: add sourceIpcidr
  // TODO: add sourcePort
  // TODO: add port

  protected otherRules: string[] = [];
  protected abstract type: 'domainset' | 'non_ip' | 'ip';

  protected pendingPromise = Promise.resolve();

  static jsonToLines = (json: unknown): string[] => stringify(json).split('\n');

  static domainWildCardToRegex = (domain: string) => {
    let result = '^';
    for (let i = 0, len = domain.length; i < len; i++) {
      switch (domain[i]) {
        case '.':
          result += String.raw`\.`;
          break;
        case '*':
          result += '[a-zA-Z0-9-_.]*?';
          break;
        case '?':
          result += '[a-zA-Z0-9-_.]';
          break;
        default:
          result += domain[i];
      }
    }
    result += '$';
    return result;
  };

  constructor(
    protected readonly span: Span,
    protected readonly id: string
  ) {}

  protected title: string | null = null;
  withTitle(title: string) {
    this.title = title;
    return this;
  }

  protected description: string[] | readonly string[] | null = null;
  withDescription(description: string[] | readonly string[]) {
    this.description = description;
    return this;
  }

  protected date = new Date();
  withDate(date: Date) {
    this.date = date;
    return this;
  }

  protected apexDomainMap: Map<string, string> | null = null;
  protected subDomainMap: Map<string, string> | null = null;
  withDomainMap(apexDomainMap: Map<string, string>, subDomainMap: Map<string, string>) {
    this.apexDomainMap = apexDomainMap;
    this.subDomainMap = subDomainMap;
    return this;
  }

  addDomain(domain: string) {
    this.domainTrie.add(domain);
    return this;
  }

  addDomainSuffix(domain: string) {
    this.domainTrie.add(domain[0] === '.' ? domain : '.' + domain);
    return this;
  }

  bulkAddDomainSuffix(domains: string[]) {
    for (let i = 0, len = domains.length; i < len; i++) {
      this.addDomainSuffix(domains[i]);
    }
    return this;
  }

  addDomainKeyword(keyword: string) {
    this.domainKeywords.add(keyword);
    return this;
  }

  private async addFromDomainsetPromise(source: AsyncIterable<string> | Iterable<string> | string[]) {
    for await (const line of source) {
      if (line[0] === '.') {
        this.addDomainSuffix(line);
      } else {
        this.addDomain(line);
      }
    }
  }

  addFromDomainset(source: AsyncIterable<string> | Iterable<string> | string[]) {
    this.pendingPromise = this.pendingPromise.then(() => this.addFromDomainsetPromise(source));
    return this;
  }

  private async addFromRulesetPromise(source: AsyncIterable<string> | Iterable<string>) {
    for await (const line of source) {
      const splitted = line.split(',');
      const type = splitted[0];
      const value = splitted[1];
      const arg = splitted[2];

      switch (type) {
        case 'DOMAIN':
          this.addDomain(value);
          break;
        case 'DOMAIN-SUFFIX':
          this.addDomainSuffix(value);
          break;
        case 'DOMAIN-KEYWORD':
          this.addDomainKeyword(value);
          break;
        case 'DOMAIN-WILDCARD':
          this.domainWildcard.add(value);
          break;
        case 'USER-AGENT':
          this.userAgent.add(value);
          break;
        case 'PROCESS-NAME':
          if (value.includes('/') || value.includes('\\')) {
            this.processPath.add(value);
          } else {
            this.processName.add(value);
          }
          break;
        case 'URL-REGEX': {
          const [, ...rest] = splitted;
          this.urlRegex.add(rest.join(','));
          break;
        }
        case 'IP-CIDR':
          (arg === 'no-resolve' ? this.ipcidrNoResolve : this.ipcidr).add(value);
          break;
        case 'IP-CIDR6':
          (arg === 'no-resolve' ? this.ipcidr6NoResolve : this.ipcidr6).add(value);
          break;
        case 'IP-ASN':
          (arg === 'no-resolve' ? this.ipasnNoResolve : this.ipasn).add(value);
          break;
        case 'GEOIP':
          (arg === 'no-resolve' ? this.groipNoResolve : this.geoip).add(value);
          break;
        default:
          this.otherRules.push(line);
          break;
      }
    }
  }

  addFromRuleset(source: AsyncIterable<string> | Iterable<string>) {
    this.pendingPromise = this.pendingPromise.then(() => this.addFromRulesetPromise(source));
    return this;
  }

  bulkAddCIDR4(cidr: string[]) {
    for (let i = 0, len = cidr.length; i < len; i++) {
      this.ipcidr.add(cidr[i]);
    }
    return this;
  }

  bulkAddCIDR4NoResolve(cidr: string[]) {
    for (let i = 0, len = cidr.length; i < len; i++) {
      this.ipcidrNoResolve.add(cidr[i]);
    }
    return this;
  }

  bulkAddCIDR6(cidr: string[]) {
    for (let i = 0, len = cidr.length; i < len; i++) {
      this.ipcidr6.add(cidr[i]);
    }
    return this;
  }

  bulkAddCIDR6NoResolve(cidr: string[]) {
    for (let i = 0, len = cidr.length; i < len; i++) {
      this.ipcidr6NoResolve.add(cidr[i]);
    }
    return this;
  }

  abstract surge(): string[];
  abstract clash(): string[];
  abstract singbox(): string[];

  async write(): Promise<void> {
    await this.pendingPromise;

    invariant(this.title, 'Missing title');
    invariant(this.description, 'Missing description');

    await Promise.all([
      compareAndWriteFile(
        this.span,
        withBannerArray(
          this.title,
          this.description,
          this.date,
          this.surge()
        ),
        path.join(OUTPUT_SURGE_DIR, this.type, this.id + '.conf')
      ),
      compareAndWriteFile(
        this.span,
        withBannerArray(
          this.title,
          this.description,
          this.date,
          this.clash()
        ),
        path.join(OUTPUT_CLASH_DIR, this.type, this.id + '.txt')
      ),
      compareAndWriteFile(
        this.span,
        this.singbox(),
        path.join(OUTPUT_SINGBOX_DIR, this.type, this.id + '.json')
      )
    ]);
  }
}

export const fileEqual = async (linesA: string[], source: AsyncIterable<string>): Promise<boolean> => {
  if (linesA.length === 0) {
    return false;
  }

  let index = -1;
  for await (const lineB of source) {
    index++;

    if (index > linesA.length - 1) {
      if (index === linesA.length && lineB === '') {
        return true;
      }
      // The file becomes smaller
      return false;
    }

    const lineA = linesA[index];

    if (lineA[0] === '#' && lineB[0] === '#') {
      continue;
    }
    if (
      lineA[0] === '/'
      && lineA[1] === '/'
      && lineB[0] === '/'
      && lineB[1] === '/'
      && lineA[3] === '#'
      && lineB[3] === '#'
    ) {
      continue;
    }

    if (lineA !== lineB) {
      return false;
    }
  }

  if (index < linesA.length - 1) {
    // The file becomes larger
    return false;
  }

  return true;
};

export async function compareAndWriteFile(span: Span, linesA: string[], filePath: string) {
  let isEqual = true;
  const linesALen = linesA.length;

  if (fs.existsSync(filePath)) {
    isEqual = await fileEqual(linesA, readFileByLine(filePath));
  } else {
    console.log(`${filePath} does not exists, writing...`);
    isEqual = false;
  }

  if (isEqual) {
    console.log(picocolors.gray(picocolors.dim(`same content, bail out writing: ${filePath}`)));
    return;
  }

  await span.traceChildAsync(`writing ${filePath}`, async () => {
    // The default highwater mark is normally 16384,
    // So we make sure direct write to file if the content is
    // most likely less than 500 lines
    if (linesALen < 500) {
      return writeFile(filePath, fastStringArrayJoin(linesA, '\n') + '\n');
    }

    const writeStream = fs.createWriteStream(filePath);
    for (let i = 0; i < linesALen; i++) {
      const p = asyncWriteToStream(writeStream, linesA[i] + '\n');
      // eslint-disable-next-line no-await-in-loop -- stream high water mark
      if (p) await p;
    }

    await asyncWriteToStream(writeStream, '\n');

    writeStream.end();
  });
}