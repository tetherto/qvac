// Polyfills run first: ES module evaluation follows source order.
import './polyfills.ts'
import { registerRootComponent } from 'expo'
import App from './App'

registerRootComponent(App)
