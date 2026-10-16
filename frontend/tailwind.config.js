/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      borderRadius: {lg:'6px',xl:'6px','2xl':'8px'},
      colors: {
        slate: {400:"#a9b1bb",500:"#8e98a5",600:"#76808d",700:"#586370"},
        'app-bg': 'var(--px-bg)', 'px-panel': 'rgb(var(--px-panel-rgb) / <alpha-value>)', 'px-raised': 'rgb(var(--px-raised-rgb) / <alpha-value>)', 'px-stroke': 'rgb(var(--px-stroke-rgb) / <alpha-value>)', 'px-accent': 'rgb(var(--px-accent-rgb) / <alpha-value>)',
        'card-bg': '#1e293b',
        'highlight': '#0ea5e9',
      },
      fontFamily: {
        sans: ['Aeonik Pro', 'IBM Plex Sans', 'Arial', 'sans-serif'],
        mono: ['Aeonik Mono', 'ui-monospace', 'monospace'],
      },
    },
  },
  plugins: [],
}
