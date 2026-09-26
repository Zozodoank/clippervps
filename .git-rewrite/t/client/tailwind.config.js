/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        shopee: {
          50: '#fff5f1',
          100: '#ffe8e0',
          500: '#ee4d2d',
          600: '#d73211',
          700: '#b4240a',
        },
        brand: {
          dark: '#0f172a',
          card: '#1e293b',
          border: '#334155',
          accent: '#6366f1',
        }
      },
      aspectRatio: {
        '9/16': '9 / 16',
      }
    },
  },
  plugins: [],
}
