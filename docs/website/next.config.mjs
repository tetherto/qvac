import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  output: 'export',
  trailingSlash: true,
  images: {
    unoptimized: true,
  },
  distDir: 'dist',
};

export default withMDX(config);
