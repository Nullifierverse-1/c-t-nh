import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers';
import fs from 'fs';

env.allowLocalModels = false;

async function test() {
  const model = await AutoModel.from_pretrained('briaai/RMBG-1.4', { config: { model_type: 'custom' } });
  const processor = await AutoProcessor.from_pretrained('briaai/RMBG-1.4', { config: { model_type: 'custom' } });
  
  // Download the image the user uploaded (Image 2) from vertex ai search storage link or I can just test with a random white anime url
  const imgUrl = 'https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png';
  const img = await RawImage.read(imgUrl); 
  const { pixel_values } = await processor(img);
  const { output } = await model({ input: pixel_values });
  
  const maskData = output.mul(255).to('uint8');
  maskData.dims = [1, maskData.dims[2], maskData.dims[3]];
  
  // Actually, I just want to see if briaai works better. 
  console.log('Processed');
}
test();
