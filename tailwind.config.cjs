/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./index.html', './src/**/*.{vue,js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        steam: {
          dark: '#1b2838',
          darker: '#171a21',
          blue: '#66c0f4',
          navy: '#2a475e',
        },
      },
    },
  },
  plugins: [],
};
