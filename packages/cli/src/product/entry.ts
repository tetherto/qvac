import { main } from './main.js'
await main(JSON.parse(Bare.argv[2] || '{}'))
