import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/**
 * Nothing here caps the build's parallelism. Left alone, Next runs one worker
 * per core and the static generation phase outgrows the deployment builder,
 * which is killed mid-phase. The worker count is set by an environment
 * variable on the builder instead — see `.env.example`.
 *
 * @type {import('next').NextConfig}
 */
const config = {
  reactStrictMode: true,
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
};

export default withMDX(config);
