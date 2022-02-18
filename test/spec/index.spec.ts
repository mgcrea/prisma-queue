import * as exported from 'src/index';

describe('module', () => {
  it('should export a stable API', () => {
    expect(exported).toMatchSnapshot();
  });
});
