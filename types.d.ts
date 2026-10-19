// text imports (`with { type: "text" }`), embedded by `bun build --compile`
declare module "*.sql" {
  const text: string;
  export default text;
}
