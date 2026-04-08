import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import { defineConfig, LibraryOptions, PluginOption } from 'vite'
import dts from 'vite-plugin-dts'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const libEntry = resolve(__dirname, 'src/lib/index.ts')
const APP_NAME = 'SwarmCollaborativeDocs'
const DEFAULT_VITE_DEV_PORT = 3002

export default defineConfig(({ mode }) => {
  const isProd = mode === 'production'
  const isLibBuild = process.env.BUILD_MODE === 'lib'

  let libOptions: LibraryOptions | undefined = undefined
  const pluginOptions: PluginOption[] = [nodePolyfills()]

  if (isLibBuild) {
    libOptions = {
      entry: libEntry,
      name: APP_NAME[0].toLocaleLowerCase() + APP_NAME.slice(1),
      formats: ['es', 'cjs'],
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fileName: format => `${APP_NAME}.${format === 'es' ? 'js' : 'cjs.js'}`,
    }

    pluginOptions.push(
      dts({
        insertTypesEntry: true,
      }),
    )
  }

  return {
    plugins: pluginOptions,
    resolve: {
      alias: { lib: libEntry },
      extensions: ['.ts', '.tsx', '.js', '.jsx', '.css', '.scss'],
    },
    optimizeDeps: {
      // include: [],
      // exclude: [],
    },
    sourcemap: !isProd,
    build: {
      lib: libOptions,
      rollupOptions: {
        external: ['@ethersphere/bee-js', 'react', 'react-dom'],
        output: {
          globals: {
            react: 'React',
            'react-dom': 'ReactDOM',
            '@ethersphere/bee-js': 'BeeJs',
          },
        },
      },
    },
    server: {
      port: DEFAULT_VITE_DEV_PORT,
      open: true,
    },
  }
})
