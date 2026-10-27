import test from 'node:test'
import { converged, network } from './harness.mjs'

// P2P_DEVICES sets the size; a fresh Core takes about a minute to be reachable, so waits are long.
const SIZE = Number(process.env.P2P_DEVICES || 4)

test(`${SIZE} devices join one workspace and every one sees all members`, async (t) => {
  const { device } = await network(t)
  const creator = device('a')
  const ready = await creator.start(['--create', '--account-name', 'Ada'])
  const invite = ready.invites.member
  const others = Array.from({ length: SIZE - 1 }, (_, i) => device(`d${i + 1}`))
  others.forEach((d, i) => d.start(['--join', invite, '--account-name', `User ${i + 1}`]))

  await converged([creator, ...others], SIZE)
})

test('a device killed mid-flight rejoins on restart, and the creator can go away and come back', async (t) => {
  const { device } = await network(t)
  const creator = device('a')
  const invite = (await creator.start(['--create', '--account-name', 'Ada'])).invites.member
  const b = device('b')
  const c = device('c')
  b.start(['--join', invite, '--account-name', 'Bo'])
  c.start(['--join', invite, '--account-name', 'Cy'])
  await converged([creator, b, c], 3)

  // no clean shutdown: the process group dies as a crash or a pulled cable would
  await b.kill()
  b.start([])
  await converged([creator, b, c], 3)

  await creator.stop()
  await converged([b, c], 3)
  creator.start([])
  await converged([creator, b, c], 3)
})

test('random kills and restarts still end with every device converged', async (t) => {
  const { device } = await network(t)
  const creator = device('a')
  const invite = (await creator.start(['--create', '--account-name', 'Ada'])).invites.member
  const others = Array.from({ length: SIZE - 1 }, (_, i) => device(`d${i + 1}`))
  others.forEach((d, i) => d.start(['--join', invite, '--account-name', `User ${i + 1}`]))
  const all = [creator, ...others]
  await converged(all, SIZE)

  let seed = Number(process.env.P2P_SEED || 1)
  const next = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31
  for (let round = 0; round < Number(process.env.P2P_ROUNDS || 4); round++) {
    const victim = all[Math.floor(next() * all.length)]
    if (next() < 0.5) {
      await victim.kill()
    } else {
      await victim.stop()
    }

    await new Promise((resolve) => setTimeout(resolve, 1000 + next() * 4000))
    victim.start([])
  }

  await converged(all, SIZE)
})
