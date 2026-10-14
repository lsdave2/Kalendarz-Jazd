export async function resolveLoginEmail(identifier:string,resolveAlias:(identifier:string)=>Promise<string|null>):Promise<string|null> {
  const value=identifier.trim();
  if(!value)return null;
  return value.includes('@')?value:resolveAlias(value.toLowerCase());
}
