/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'app-bg': '#0f172a',
        'card-bg': '#1e293b',
        'highlight': '#0ea5e9',
      }
    },
  },
  plugins: [],
}
