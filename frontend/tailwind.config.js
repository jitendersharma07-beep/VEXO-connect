/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        // VEXO brand palette (from vexo-website/src/app/globals.css). Legacy
        // token names kept so existing classes need no sweep: "orange" now
        // carries the VEXO cyan accent, "ember" its darker text/hover pair.
        pos: {
          royal: '#1550E6',
          deep: '#0B1730',
          bright: '#2D6BFF',
          orange: '#12BEDE',
          ember: '#0A97B4',
          surface: '#F7F9FC',
          ink: '#0A1424',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'sans-serif',
        ],
      },
    },
  },
  plugins: [],
};
