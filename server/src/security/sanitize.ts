import sanitizeHtml from 'sanitize-html';
import type { SanitizedEmailResult, SuspiciousLink } from '../types.js';

const TRACKING_PIXEL_PATTERNS = [
  /width\s*=\s*["']?[01]["']?/i,
  /height\s*=\s*["']?[01]["']?/i,
  /open|track|pixel|beacon|telemetry/i,
];

function extractDomainFromUrl(rawUrl: string): string | null {
  try {
    const parsed = new URL(rawUrl);
    return parsed.hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isIpAddress(host: string): boolean {
  return /^(\d{1,3}\.){3}\d{1,3}$/.test(host) || host.startsWith('[');
}

function detectSuspiciousLinks(html: string): SuspiciousLink[] {
  const suspicious: SuspiciousLink[] = [];
  const seen = new Set<string>();
  const anchorRegex = /<a\b[^>]*href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;

  let match: RegExpExecArray | null;
  while ((match = anchorRegex.exec(html)) !== null) {
    const rawHref = (match[1] || match[2] || match[3] || '').trim();
    const innerText = match[4].replace(/<[^>]+>/g, '').trim();
    if (!rawHref) continue;

    if (/^(javascript|vbscript|data):/i.test(rawHref)) {
      const key = `scheme:${rawHref}`;
      if (!seen.has(key)) {
        seen.add(key);
        suspicious.push({
          href: rawHref,
          displayText: innerText || rawHref,
          reason: 'Blocked executable or data URI scheme',
        });
      }
      continue;
    }

    const hrefDomain = extractDomainFromUrl(rawHref);
    if (!hrefDomain) continue;

    if (hrefDomain.includes('xn--')) {
      const key = `puny:${rawHref}`;
      if (!seen.has(key)) {
        seen.add(key);
        suspicious.push({
          href: rawHref,
          displayText: innerText || rawHref,
          reason: `Internationalized (punycode) domain "${hrefDomain}" may disguise target`,
        });
      }
    } else if (isIpAddress(hrefDomain)) {
      const key = `ip:${rawHref}`;
      if (!seen.has(key)) {
        seen.add(key);
        suspicious.push({
          href: rawHref,
          displayText: innerText || rawHref,
          reason: `Direct IP address link (${hrefDomain})`,
        });
      }
    }

    // Check if visible link text looks like another domain/URL
    const textUrlMatch = innerText.match(/(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(?:\/|\b)/i);
    if (textUrlMatch) {
      const textDomain = textUrlMatch[1].toLowerCase();
      if (
        textDomain !== hrefDomain &&
        !hrefDomain.endsWith(`.${textDomain}`) &&
        !textDomain.endsWith(`.${hrefDomain}`)
      ) {
        const key = `mismatch:${rawHref}:${textDomain}`;
        if (!seen.has(key)) {
          seen.add(key);
          suspicious.push({
            href: rawHref,
            displayText: innerText,
            reason: `Displayed link "${textDomain}" points to a different domain "${hrefDomain}"`,
          });
        }
      }
    }
  }
  return suspicious;
}

export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function buildSnippet(text: string, maxLen = 160): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLen) return normalized;
  return `${normalized.slice(0, maxLen - 1).trimEnd()}…`;
}

export function sanitizeEmailContent(rawHtml: string, rawText = ''): SanitizedEmailResult {
  const suspiciousLinks = detectSuspiciousLinks(rawHtml || '');
  let hasExternalImages = false;

  const cleanHtml = sanitizeHtml(rawHtml || '', {
    allowedTags: [
      'a', 'abbr', 'b', 'blockquote', 'br', 'caption', 'code', 'col', 'colgroup',
      'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
      'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span',
      'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot',
      'th', 'thead', 'tr', 'u', 'ul',
    ],
    allowedAttributes: {
      a: ['href', 'title', 'target', 'rel'],
      img: ['src', 'data-blocked-src', 'alt', 'title', 'width', 'height', 'style'],
      '*': ['style', 'align', 'valign', 'colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'tel'],
    allowedSchemesByTag: {
      img: ['http', 'https', 'cid', 'data'],
    },
    allowedStyles: {
      '*': {
        color: [/^#[0-9a-f]{3,8}$/i, /^rgb\(/i, /^rgba\(/i, /^[a-z]+$/i],
        'background-color': [/^#[0-9a-f]{3,8}$/i, /^rgb\(/i, /^rgba\(/i, /^[a-z]+$/i],
        'font-size': [/^\d+(?:px|em|rem|pt|%)$/i],
        'font-family': [/^[^;{}()<>]+$/],
        'font-weight': [/^(normal|bold|bolder|lighter|\d{3})$/i],
        'font-style': [/^(normal|italic|oblique)$/i],
        'text-align': [/^(left|right|center|justify)$/i],
        'text-decoration': [/^(none|underline|line-through)$/i],
        padding: [/^[0-9pxemrem%\s.-]+$/i],
        margin: [/^[0-9pxemrem%\s.-]+$/i],
        border: [/^[^;{}()<>]+$/],
        'border-collapse': [/^(collapse|separate)$/i],
        width: [/^\d+(?:px|%|em|rem)$/i],
        'max-width': [/^\d+(?:px|%|em|rem)$/i],
      },
    },
    transformTags: {
      a: (_tagName, attribs): sanitizeHtml.Tag => {
        const href = (attribs.href || '').trim();
        if (!href || /^(javascript|vbscript|data):/i.test(href)) {
          return {
            tagName: 'span',
            attribs: { class: 'cadence-blocked-link' },
          };
        }
        const safeAttribs: sanitizeHtml.Attributes = {
          ...attribs,
          href,
          target: '_blank',
          rel: 'noopener noreferrer nofollow',
        };
        return {
          tagName: 'a',
          attribs: safeAttribs,
        };
      },
      img: (_tagName, attribs) => {
        const src = (attribs.src || '').trim();
        // Strip obvious 1x1 remote tracking pixels
        const tagSnapshot = `${attribs.width || ''} ${attribs.height || ''} ${src}`;
        const looksLikeTracker =
          /^https?:/i.test(src) &&
          ((attribs.width === '1' && attribs.height === '1') ||
            (attribs.width === '0' && attribs.height === '0') ||
            TRACKING_PIXEL_PATTERNS.some((p) => p.test(tagSnapshot) && (attribs.width === '1' || attribs.height === '1')));

        if (looksLikeTracker) {
          return { tagName: 'span', attribs: { 'data-tracker-blocked': 'true' } };
        }

        if (/^https?:/i.test(src)) {
          hasExternalImages = true;
          return {
            tagName: 'img',
            attribs: {
              ...attribs,
              'data-blocked-src': src,
              src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
              alt: attribs.alt || 'External image blocked for privacy',
            },
          };
        }

        if (/^data:image\/(png|jpeg|jpg|gif|webp);base64,/i.test(src) || /^cid:/i.test(src)) {
          return { tagName: 'img', attribs };
        }

        return { tagName: 'span', attribs: {} };
      },
    },
  });

  const derivedText = rawText?.trim() ? rawText.trim() : htmlToPlainText(cleanHtml);
  const snippet = buildSnippet(derivedText || rawHtml);

  return {
    html: cleanHtml,
    text: derivedText,
    snippet,
    hasExternalImages,
    suspiciousLinks,
  };
}

export function sanitizeComposerHtml(rawHtml: string): string {
  return sanitizeHtml(rawHtml || '', {
    allowedTags: [
      'a', 'b', 'blockquote', 'br', 'code', 'div', 'em', 'h1', 'h2', 'h3', 'hr',
      'i', 'img', 'li', 'mark', 'ol', 'p', 'pre', 's', 'span', 'strong', 'sub',
      'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt', 'width', 'height', 'style'],
      '*': ['style', 'colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'cid', 'data'],
  });
}
