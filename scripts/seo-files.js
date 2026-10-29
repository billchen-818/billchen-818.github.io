'use strict';

const escapeXml = (value = '') => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

const stripHtml = (value = '') => String(value)
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ');

hexo.extend.generator.register('seo-files', (locals) => {
  const siteUrl = hexo.config.url.replace(/\/$/, '');
  const posts = locals.posts.sort('-date').toArray();
  const tags = locals.tags.toArray();
  const absoluteUrl = (path = '') => `${siteUrl}/${path.replace(/^\//, '')}`;
  const lastUpdated = posts[0] ? (posts[0].updated || posts[0].date).toISOString() : new Date().toISOString();

  const sitemapEntries = [
    { path: '', updated: lastUpdated },
    { path: 'archives/', updated: lastUpdated },
    { path: 'tags/', updated: lastUpdated },
    ...posts.map((post) => ({ path: post.path, updated: (post.updated || post.date).toISOString() })),
    ...tags.map((tag) => ({ path: tag.path, updated: lastUpdated }))
  ];

  const sitemap = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...sitemapEntries.map(({ path, updated }) => [
      '  <url>',
      `    <loc>${escapeXml(absoluteUrl(path))}</loc>`,
      `    <lastmod>${escapeXml(updated)}</lastmod>`,
      '  </url>'
    ].join('\n')),
    '</urlset>'
  ].join('\n');

  const feedEntries = posts.slice(0, 20).map((post) => {
    const summary = stripHtml(post.excerpt || post.content || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    const postUrl = absoluteUrl(post.path);
    return [
      '  <entry>',
      `    <title>${escapeXml(post.title)}</title>`,
      `    <id>${escapeXml(postUrl)}</id>`,
      `    <link href="${escapeXml(postUrl)}"/>`,
      `    <updated>${escapeXml((post.updated || post.date).toISOString())}</updated>`,
      `    <summary>${escapeXml(summary)}</summary>`,
      '  </entry>'
    ].join('\n');
  });

  const atom = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    `  <title>${escapeXml(hexo.config.title)}</title>`,
    `  <id>${escapeXml(absoluteUrl(''))}</id>`,
    `  <link href="${escapeXml(absoluteUrl('atom.xml'))}" rel="self"/>`,
    `  <link href="${escapeXml(absoluteUrl(''))}"/>`,
    `  <updated>${escapeXml(lastUpdated)}</updated>`,
    ...feedEntries,
    '</feed>'
  ].join('\n');

  const robots = [
    'User-agent: *',
    'Allow: /',
    `Sitemap: ${absoluteUrl('sitemap.xml')}`,
    ''
  ].join('\n');

  return [
    { path: 'sitemap.xml', data: sitemap },
    { path: 'atom.xml', data: atom },
    { path: 'robots.txt', data: robots }
  ];
});
