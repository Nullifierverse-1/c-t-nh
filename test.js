import { AutoModel, AutoProcessor, RawImage, env } from '@huggingface/transformers';

env.allowLocalModels = false;

async function test() {
  console.log('Loading model...');
  const model = await AutoModel.from_pretrained('briaai/RMBG-1.4', { config: { model_type: 'custom' } });
  const processor = await AutoProcessor.from_pretrained('briaai/RMBG-1.4', { config: { model_type: 'custom' } });
  console.log('Done model');
  
  const img = await RawImage.read('https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png');
  const { pixel_values } = await processor(img);
  const { output } = await model({ input: pixel_values });
  try {
    const maskData = output.mul(255).to('uint8');
    const maskData3D = maskData.clone();
    maskData3D.dims = [1, maskData.dims[2], maskData.dims[3]];
    const mask = await RawImage.fromTensor(maskData3D).resize(img.width, img.height);
    console.log('has resize', mask.width, mask.height);
  } catch (e) {
    console.log(e.stack);
  }
}
test();
