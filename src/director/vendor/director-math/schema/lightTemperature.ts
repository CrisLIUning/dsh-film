// @ts-nocheck — vendored from the 3D director desk by scripts/sync-director-math.ts.
// Type-checked in the desk's own tsconfig; pinned by hash in director-math.manifest.json.
// Do not edit here: change the desk, then re-run the script.
/** Approximate blackbody chromaticity, not a spectral renderer or camera white balance.
 * Integrates Planck radiance against Wyman et al.'s analytic CIE 1931 matching
 * functions (JCGT 2(2), 2013), then transforms XYZ to linear sRGB. */
export function lightTemperatureRgb(kelvin:number):[number,number,number] {
  if(!Number.isFinite(kelvin)||kelvin<2000||kelvin>10000)throw new Error('色温需要 2000–10000 K');
  const g=(w:number,c:number,left:number,right:number)=>Math.exp(-.5*((w-c)*(w<c?left:right))**2);
  let X=0,Y=0,Z=0;
  for(let w=380;w<=780;w+=5){
    const power=1/((w/560)**5*Math.expm1(14387768.77/(w*kelvin)));
    X+=power*(1.056*g(w,599.8,.0264,.0323)+.362*g(w,442,.0624,.0374)-.065*g(w,501.1,.049,.0382));
    Y+=power*(.821*g(w,568.8,.0213,.0247)+.286*g(w,530.9,.0613,.0322));
    Z+=power*(1.217*g(w,437,.0845,.0278)+.681*g(w,459,.0385,.0725));
  }
  const rgb=[3.2406*X-1.5372*Y-.4986*Z,-.9689*X+1.8758*Y+.0415*Z,.0557*X-.204*Y+1.057*Z];
  const max=Math.max(...rgb);return rgb.map(v=>Math.max(0,v/max)) as [number,number,number];
}
