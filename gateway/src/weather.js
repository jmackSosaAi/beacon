// Chicago (campus) daily forecast from Open-Meteo: free, no key, public data.
const WMO={0:'clear',1:'mostly clear',2:'partly cloudy',3:'overcast',45:'foggy',48:'foggy',51:'light drizzle',53:'drizzle',55:'heavy drizzle',56:'freezing drizzle',57:'freezing drizzle',61:'light rain',63:'rain',65:'heavy rain',66:'freezing rain',67:'freezing rain',71:'light snow',73:'snow',75:'heavy snow',77:'snow grains',80:'rain showers',81:'rain showers',82:'heavy showers',85:'snow showers',86:'heavy snow showers',95:'thunderstorms',96:'thunderstorms with hail',99:'thunderstorms with hail'};
export async function chicagoWeather(){
  try{
    const url='https://api.open-meteo.com/v1/forecast?latitude=41.79&longitude=-87.60&daily=temperature_2m_max,temperature_2m_min,precipitation_probability_max,weather_code,wind_speed_10m_max&temperature_unit=fahrenheit&wind_speed_unit=mph&timezone=America%2FChicago&forecast_days=1';
    const d=(await (await fetch(url,{signal:AbortSignal.timeout(6000)})).json()).daily;
    const hi=Math.round(d.temperature_2m_max[0]),lo=Math.round(d.temperature_2m_min[0]),rain=d.precipitation_probability_max[0],wind=Math.round(d.wind_speed_10m_max[0]);
    let line=`Chicago weather: ${WMO[d.weather_code[0]]||'mixed'}, high of ${hi}, low of ${lo}`;
    if(rain>=30)line+=`, ${rain} percent chance of precipitation${rain>=60?', bring an umbrella':''}`;
    if(wind>=20)line+=`, windy up to ${wind} miles per hour`;
    // Short form for the phone call.
    const short=`${hi} and ${WMO[d.weather_code[0]]||'mixed'}, low ${lo}${rain>=40?`, ${rain} percent chance of rain`:''}.`;
    return {line:line+'.',short};
  }catch{return null;}
}
