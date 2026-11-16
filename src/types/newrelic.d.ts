// The subset of the New Relic agent API this server uses. The agent package
// ships no types and @types/newrelic is several majors behind.
declare module "newrelic" {
  const newrelic: {
    setTransactionName(name: string): void;
    addCustomAttributes(attributes: Record<string, string | number | boolean>): void;
  };
  export default newrelic;
}
