/**
 * StreamResolver
 * Extracts HLS manifests from provider JSON, text and nested payloads.
 */
class StreamResolver {
  static SCHEMA_PATHS = [
    (d) => d?.file,
    (d) => d?.src,
    (d) => d?.url,
    (d) => d?.stream?.playlist,
    (d) => d?.stream?.url,
    (d) => d?.sources?.[0]?.file,
    (d) => d?.sources?.[0]?.url,
    (d) => d?.data?.sources?.[0]?.file,
    (d) => d?.data?.sources?.[0]?.url,
    (d) => d?.result?.sources?.[0]?.file,
    (d) => d?.result?.sources?.[0]?.url,
    (d) => Array.isArray(d?.sources)
      ? d.sources.find((s) => typeof s?.file === 'string' && s.file.includes('.m3u8'))?.file ||
        d.sources.find((s) => typeof s?.url === 'string' && s.url.includes('.m3u8'))?.url
      : null
  ];

  static normalize(value) {
    if (typeof value !== 'string') return null;
    return value
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
      .trim();
  }

  static isManifest(value) {
    return typeof value === 'string' && (
      value.includes('.m3u8') || value.includes('/hls/')
    );
  }

  static deepFindM3u8(obj, seen = new Set()) {
    if (!obj || typeof obj !== 'object' || seen.has(obj)) return null;
    seen.add(obj);

    for (const value of Object.values(obj)) {
      if (this.isManifest(value)) return this.normalize(value);
      if (value && typeof value === 'object') {
        const found = this.deepFindM3u8(value, seen);
        if (found) return found;
      }
    }
    return null;
  }

  static extractManifestUrl(rawBody) {
    if (!rawBody) return null;

    let text;
    let parsedJson = null;

    if (Buffer.isBuffer(rawBody)) text = rawBody.toString('utf8');
    else if (typeof rawBody === 'string') text = rawBody;
    else if (typeof rawBody === 'object') {
      parsedJson = rawBody;
      text = JSON.stringify(rawBody);
    } else return null;

    if (!parsedJson && text) {
      try { parsedJson = JSON.parse(text); } catch (_) {}
    }

    if (parsedJson) {
      for (const accessor of this.SCHEMA_PATHS) {
        try {
          const candidate = accessor(parsedJson);
          if (this.isManifest(candidate)) return this.normalize(candidate);
        } catch (_) {}
      }

      const recursiveResult = this.deepFindM3u8(parsedJson);
      if (recursiveResult) return recursiveResult;
    }

    if (text) {
      const match = text.match(/https?:\\?\/\\?\/[^"'\\s<>]+(?:\\.m3u8|\/hls\/)[^"'\\s<>]*/i);
      if (match) return this.normalize(match[0]);
    }

    return null;
  }
}

module.exports = StreamResolver;
