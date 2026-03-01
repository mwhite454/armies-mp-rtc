import { define } from "../utils.ts";

export default define.page(function App({ Component }) {
  return (
    <html lang="en" data-theme="night">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Tactical Grid</title>
      </head>
      <body class="min-h-screen bg-base-100 text-base-content font-mono">
        <Component />
      </body>
    </html>
  );
});
