// The connector download button points at the "connector-latest" release of THIS GitHub repo (built by .github/workflows).
// Vercel provides the repo owner/name automatically, so nothing needs to be configured.
const owner = process.env.VERCEL_GIT_REPO_OWNER, slug = process.env.VERCEL_GIT_REPO_SLUG;
const download = process.env.NEXT_PUBLIC_CONNECTOR_DOWNLOAD_URL
  || (owner && slug ? `https://github.com/${owner}/${slug}/releases/download/connector-latest/TallyCloudConnector.exe` : '');

/** @type {import('next').NextConfig} */
export default { env: { NEXT_PUBLIC_CONNECTOR_DOWNLOAD_URL: download }, poweredByHeader: false };
