// You can import your modules
// import index from '../src/index'

import nock from 'nock'
import { Probot } from 'probot'
// Requiring our app implementation
import myProbotApp from '../src'
import checkRunSuccess from './fixtures/check_run.created.json'
// Requiring our fixtures
import checkSuitePayload from './fixtures/check_suite.requested.json'

nock.disableNetConnect()

describe('My Probot app', () => {
  let probot: any

  beforeEach(() => {
    probot = new Probot({})
    // Load our app into probot
    const app = probot.load(myProbotApp)

    // just return a test token
    app.app = () => 'test'
  })

  test('creates a passing check', async () => {
    nock('https://api.github.com')
      .post('/app/installations/2/access_tokens')
      .reply(200, { token: 'test' })

    nock('https://api.github.com')
      .post('/repos/hiimbex/testing-things/check-runs', (body: any) => {
        body.started_at = '2018-10-05T17:35:53.683Z'
        expect(body).toMatchObject(checkRunSuccess)
        return true
      })
      .reply(200)

    // Receive a webhook event
    await probot.receive({ name: 'check_suite', payload: checkSuitePayload })
  })
})

// For more information about testing with Jest see:
// https://facebook.github.io/jest/

// For more information about using TypeScript in your tests, Jest recommends:
// https://github.com/kulshekhar/ts-jest

// For more information about testing with Nock see:
// https://github.com/nock/nock
