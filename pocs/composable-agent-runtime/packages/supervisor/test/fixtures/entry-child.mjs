import Supervisor from '../../index.js'
import stowEntry from '../../entry.js'

// Entry fixture: a stowEntry-wrapped tree whose worker echoes ipc data and, on
// 'giveup', dies with restart:'never' — exhaustion escalates to exit(1).
export default stowEntry(async (ipc) => {
  const sup = new Supervisor()
  let kill = null
  sup.add('worker', {
    restart: 'never',
    start: ({ onDeath }) => {
      kill = () => onDeath(new Error('worker asked to die'))
      return { alive: true }
    },
    stop: noop
  })
  ipc.on('data', (data) => {
    if (data.toString() === 'giveup') kill?.()
    else ipc.write(data)
  })
  return sup
})

function noop() {}
