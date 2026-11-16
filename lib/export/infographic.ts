import styles from '../../assets/infographic.css?inline';

export function buildInfographicHtml(article: HTMLElement): string {
  // The article is rendered by React from validated fields and canonical post links.
  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
  <title>Infografía · Xense</title>
  <style>${styles}</style>
</head>
<body class="ig-export">
${article.outerHTML}
</body>
</html>`;
}
