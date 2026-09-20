/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        pos: {
          royal: '#1E40AF',
          deep: '#172554',
          bright: '#2563EB',
          orange: '#F97316',
          ember: '#EA580C',
          surface: '#F8FAFC',
          ink: '#0F172A',
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
