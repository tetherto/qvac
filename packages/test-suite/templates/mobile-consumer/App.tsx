import 'react-native-url-polyfill/auto'
import React from 'react'
import { activateKeepAwakeAsync } from 'expo-keep-awake'
import BatchConsumer from './batch-consumer'
// MOBILE_INIT_IMPORT_PLACEHOLDER

activateKeepAwakeAsync()

export default function App() {
  // MOBILE_INIT_REFERENCE_PLACEHOLDER
  return <BatchConsumer />
}
