# Tests

## Running Unit Tests

To run unit tests (using the `brittle-bare` runner):

```sh
npm run test:unit
```

## Running Integration Tests

To run integration tests (using the `brittle-bare` runner):

```sh
npm run test:integration
```

## Test Coverage

To generate a unit test coverage report (using `brittle` and `istanbul`):

```sh
npm run coverage:unit
```

To generate an integration test coverage report:

```sh
npm run coverage:integration
```

To generate a coverage report for all tests (unit and integration):

```sh
npm run coverage
```

Coverage reports are generated in the `coverage/unit/`, `coverage/integration/`, and `coverage/all/` directories, respectively. Open the corresponding `index.html` file in your browser to view the detailed report.

## Test Reporting

Test and coverage commands output results to the console and generate reports in standard formats (text and HTML). These reports can be used locally or integrated with CI/CD pipelines for automated reporting.