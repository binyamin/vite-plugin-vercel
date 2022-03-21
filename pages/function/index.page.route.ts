import { PageContextBuiltIn } from 'vite-plugin-ssr/types';

export const ignoreVercelRouteFunctionError = true;

export default (pageContext: PageContextBuiltIn) => {
  if (!pageContext.url.startsWith('/function/')) return false;
  return {
    precedence: -1,
  };
};
