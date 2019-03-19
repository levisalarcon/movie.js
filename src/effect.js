// TODO: investigate why an effect might run once in the beginning even if its layer isn't at the beginning
// TODO: Add audio effect support
import {val, linearInterp, cosineInterp, mapPixels} from "./util.js";

/**
 * Any effect that modifies the visual contents of a layer.
 *
 * <em>Note: At this time, simply use the <code>actx</code> property of the movie to add audio nodes to a
 * layer's media. TODO: add more audio support, including more types of audio nodes, probably in a
 * different module.</em>
 */
export class Base {
    // subclasses must implement apply (javascript's lame attempt of an abstract method lol)
    apply(target, reltime) {
        throw "No overriding method found or super.apply was called";
    }
}

/**
 * To optimize creation of common objects between shader effects that use the same canvas.
 * Ideally, there should be one <code>ShaderGroup</code> per movie/canvas that use shader effects.
 */
export class ShaderGroup {
    constructor(movie) {
        this.movie = movie;

        // setup webgl (for image mapping effects)
        const gl = canvas.getContext("webgl");
        if (gl === null) {
            console.warn("Unable to initialize WebGL! Your browser or machine may not support it.");
        }

        this.buffers = ShaderGroup._initRectBuffers(gl);
        this.texture = ShaderGroup._loadTexture(gl, this.canvas); // the canvas, expressed as a gl texture
        this.modelViewMatrix = ShaderGroup._createIdentityMatrix4();    // the same for all effects
        let aspect = movie.canvas.clientWidth / movie.canvas.clientHeight;    // can you do movie.width / movie.height?
        this.projectionMatrix = ShaderGroup._createProjectionMatrix4(aspect);    // the same for all effects

        // listen for dimension changes and update projection matrix
        movie.canvas.addEventListener("resize", () => {
            let aspect = movie.canvas.clientWidth / movie.canvas.clientHeight;    // can you do movie.width / movie.height?
            this.projectionMatrix = ShaderGroup._createProjectionMatrix4(aspect);    // `this` is the shader group
        });

        this.gl = gl;
    }
}
/*
 * Implement **bare essentials** of webgl matrix math, which is enough for our purposes.
 * (even no matrix multiplication)
 */
ShaderGroup._createIdentityMatrix4 = () => {
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 1, 0,
        0, 0, 0, 1
    ];
};
ShaderGroup._createProjectionMatrix4 = (aspect, fov=/*45 deg*/45*Math.PI/180, near=.1, far=10) => {
    // left = -1, right = +1; bottom = -1, top = +1
    let m = -2/(far-near),
        n = -(far+near)/(far-near);
    return [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, m, 0,
        0, 0, n, 1
    ];
};
ShaderGroup._initRectBuffers = const(gl) {
    const vertices = [
        // the screen/canvas (output)
        -1.0,  1.0,
         1.0,  1.0,
        -1.0, -1.0,
         1.0, -1.0,
    ];
    const texCoords = [
        // the texture/canvas (input)
        0.0, 1.0,
        1.0, 1.0,
        0.0, 0.0,
        1.0, 0.0
    ];

    return {
        vertices: ShaderGroup._initBuffer(gl, vertices),
        texCoords: ShaderGroup._initBuffer(gl, texCoords)
    };
}
/**
 * Creates the quad covering the screen
 */
ShaderGroup._initBuffer = const(gl, data) {
    const positionBuffer = gl.createBuffer();

    // Select the positionBuffer as the one to apply buffer operations to from here out.
    gl.bindBuffer(gl.ARRAY_BUFFER, data);

    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(positions), gl.STATIC_DRAW);

    return positionBuffer;
}
ShaderGroup._loadTexture = (gl, canvas, level=0, internalFormat=undefined, srcFormat=undefined, srcType=undefined) => {
    internalFormat = internalFormat || gl.RGBA;
    srcFormat = srcFormat || gl.RGBA;
    srcType = srcType || gl.UNSIGNED_BYTE;

    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);

    // set to `canvas`
    gl.texImage2D(gl.TEXTURE_2D, level, internalFormat, srcFormat, srcType, canvas);

    // WebGL1 has different requirements for power of 2 images
    // vs non power of 2 images so check if the image is a
    // power of 2 in both dimensions.
    if (isPowerOf2(canvas.width) && isPowerOf2(canvas.height)) {
        // Yes, it's a power of 2. Generate mips.
        gl.generateMipmap(gl.TEXTURE_2D);
    } else {
        // No, it's not a power of 2. Turn off mips and set
        // wrapping to clamp to edge
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    }

    return tex;
};

/**
 * Any effect that modifies each pixel using an algorithm.
 */
export class Shader extends Base {
    /**
     * @param {ShaderGroup} group
     * @param {string} fragmentSource - the fragment shader (you can't modify movie.js's default vertex shader)
     */
    constructor(group, fragmentSource) {
        super();

        this._group = group;
        this._program = Shader._initShaderProgram(gl, Shader._VERTEX_SOURCE, fragmentSource);
        this._attribLocations = {
            vertexPosition: gl.getAttribLocation(this.program, "a_VertexPosition"),
            textureCoord: gl.getAttribLocation(this.program, "a_TextureCoord")
        };
        this._uniformLocations = {
            projectionMatrix: gl.getUniformLocation(shaderProgram, "u_ProjectionMatrix"),
            modelViewMatrix: gl.getUniformLocation(shaderProgram, "u_ModelViewMatrix"),
            sampler: gl.getUniformLocation(shaderProgram, "u_Sampler"),
        };
    }

    apply(target, reltime) {
        const gl = this._group.gl;

        gl.clearColor(0.0, 0.0, 0.0, 0.0);  // clear to transparency; TODO: test
        gl.clearDepth(1.0);         // clear everything
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);

        gl.clear(gl.GL_COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        // Tell WebGL how to pull out the positions from the position
        // buffer into the vertexPosition attribute.
        {
            const numComponents = 2;  // pull out 2 values per iteration
            const type = gl.FLOAT;    // the data in the buffer is 32bit floats
            const normalize = false;  // don't normalize
            const stride = 0;         // how many bytes to get from one set of values to the next
                                      // 0 = use type and numComponents above
            const offset = 0;         // how many bytes inside the buffer to start from
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.position);
            gl.vertexAttribPointer(
                this.attribLocations.vertexPosition,
                numComponents,
                type,
                normalize,
                stride,
                offset);
            gl.enableVertexAttribArray(
                this.attribLocations.vertexPosition);
        }

        // tell webgl how to pull out the texture coordinates from buffer
        {
            const num = 2; // every coordinate composed of 2 values (uv)
            const type = gl.FLOAT; // the data in the buffer is 32 bit float
            const normalize = false; // don't normalize
            const stride = 0; // how many bytes to get from one set to the next
            const offset = 0; // how many bytes inside the buffer to start from
            gl.bindBuffer(gl.ARRAY_BUFFER, this.buffers.textureCoord);
            gl.vertexAttribPointer(this.attribLocations.textureCoord, num, type, normalize, stride, offset);
            gl.enableVertexAttribArray(this.attribLocations.textureCoord);
        }

        // Tell WebGL we want to affect texture unit 0
        gl.activeTexture(gl.TEXTURE0);

        // Bind the texture to texture unit 0
        gl.bindTexture(gl.TEXTURE_2D, texture);

        // Tell the shader we bound the texture to texture unit 0
        gl.uniform1i(this.uniformLocations.sampler, 0);

        gl.useProgram(this.program);

        // Set the shader uniforms

        gl.uniformMatrix4fv(
            this.uniformLocations.projectionMatrix,
            false,
            this._group.projectionMatrix
        );
        gl.uniformMatrix4fv(
            this.uniformLocations.modelViewMatrix,
            false,
            this._group.modelViewMatrix
        );

        {
            const offset = 0;
            const vertexCount = 4;
            gl.drawArrays(gl.TRIANGLE_STRIP, offset, vertexCount);
        }
    }
}
// https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/Tutorial/Adding_2D_content_to_a_WebGL_context
Shader._initShaderProgram = const(gl, vertexSrc, fragmentSrc) {
    const vertexShader = Shader._loadShader(gl, gl.VERTEX_SHADER, vertexSrc);
    const fragmentShader = Shader._loadShader(gl, gl.FRAGMENT_SHADER, fragmentSrc);

    const shaderProgram = gl.createProgram();
    gl.attachShader(shaderProgram, vertexShader);
    gl.attachShader(shaderProgram, fragmentShader);
    gl.linkProgram(shaderProgram);

    // check program creation status
    if (!gl.getProgramParameter(shaderProgram, gl.LINK_STATUS)) {
        console.warn("Unable to link shader program: " + gl.getProgramInfoLog(shaderProgram));
        return null;
    }

    return shaderProgram;
};
Shader._loadShader = const(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    // check compile status
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.warn("An error occured compiling shader: " + gl.getShaderInfoLog(shader));
        gl.deleteShader(shader);
        return null;
    }

    return shader;
};
Shader._VERTEX_SOURCE = `
    attribute vec4 a_VertexPosition;
    attribute vec2 a_TextureCoord;

    uniform mat4 u_ModelViewMatrix;
    uniform mat4 u_ProjectionMatrix;

    varying highp vec2 v_TextureCoord;

    void main(void) {
        gl_Position = u_ProjectionMatrix * u_ModelViewMatrix * a_VertexPosition;
        v_TextureCoord = a_TextureCoord;
    }
`;

/* COLOR & TRANSPARENCY */
/** Changes the brightness */
export class Brightness extends Base {
    constructor(brightness=1.0) {
        super();
        this.brightness = brightness;
    }
    apply(target, reltime) {
        const brightness = val(this.brightness, target, reltime);
        mapPixels((data, start) => {
            for (let i=0; i<3; i++) data[start+i] *= brightness;
        }, target.canvas, target.cctx);
    }
}

/** Changes the contrast */
export class Contrast extends Base {
    constructor(contrast=1.0) {
        super();
        this.contrast = contrast;
    }
    apply(target, reltime) {
        const contrast = val(this.contrast, target, reltime);
        mapPixels((data, start) => {
            for (let i=0; i<3; i++) data[start+i] = contrast * (data[start+i] - 128) + 128;
        }, target.canvas, target.cctx);
    }
}

/**
 * Multiplies each channel by a different constant
 */
export class Channels extends Base {
    constructor(factors) {
        super();
        this.factors = factors;
    }
    apply(target, reltime) {
        const factors = val(this.factors, target, reltime);
        if (factors.a > 1 || (factors.r < 0 || factors.g < 0 || factors.b < 0 || factors.a < 0))
            throw "Invalid channel factors";
        mapPixels((data, start) => {
            data[start+0] *= factors.r || 1;    // do defaults here to account for keyframes
            data[start+1] *= factors.g || 1;
            data[start+2] *= factors.b || 1;
            data[start+3] *= factors.a || 1;
        }, target.canvas, target.cctx);
    }
}

/**
 * Reduces alpha for pixels which, by some criterion, are close to a specified target color
 */
export class ChromaKey extends Base {
    /**
     * @param {Color} [target={r: 0, g: 0, b: 0}] - the color to target
     * @param {number} [threshold=0] - how much error is allowed
     * @param {boolean|function} [interpolate=null] - the function used to interpolate the alpha channel,
     *  creating an anti-aliased alpha effect, or a falsy value for no smoothing (i.e. 255 or 0 alpha)
     * (@param {number} [smoothingSharpness=0] - a modifier to lessen the smoothing range, if applicable)
     */
    // TODO: use smoothingSharpness
    constructor(targetColor={r: 0, g: 0, b: 0}, threshold=0, interpolate=null/*, smoothingSharpness=0*/) {
        super();
        this.targetColor = target;
        this.threshold = threshold;
        this.interpolate = interpolate;
        // this.smoothingSharpness = smoothingSharpness;
    }
    apply(target, reltime) {
        const targetColor = val(this.targetColor, target, reltime), threshold = val(this.threshold, target, reltime),
            interpolate = val(this.interpolate, target, reltime),
            smoothingSharpness = val(this.smoothingSharpness, target, reltime);
        mapPixels((data, start) => {
            let r = data[start+0];
            let g = data[start+1];
            let b = data[start+2];
            if (!interpolate) {
                // standard dumb way that most video editors probably do it (all-or-nothing method)
                let transparent = (Math.abs(r - targetColor.r) <= threshold)
                    && (Math.abs(g - targetColor.g) <= threshold)
                    && (Math.abs(b - targetColor.b) <= threshold);
                if (transparent) data[start+3] = 0;
            } else {
                /*
                    better way IMHO:
                    Take the average of the absolute differences between the pixel and the target for each channel
                */
                let dr = Math.abs(r - targetColor.r);
                let dg = Math.abs(g - targetColor.g);
                let db = Math.abs(b - targetColor.b);
                let transparency = (dr + dg + db) / 3;
                transparency = interpolate(0, 255, transparency/255);  // TODO: test
                data[start+3] = transparency;
            }
        }, target.canvas, target.cctx);
    }
}

/* BLUR */
// TODO: make sure this is truly gaussian even though it doens't require a standard deviation
// TODO: improve performance and/or make more powerful
/** Applies a Guassian blur */
export class GuassianBlur extends Base {
    constructor(radius) {
        super();
        this.radius = radius;
        // TODO: get rid of tmpCanvas and just take advantage of image data's immutability
        this._tmpCanvas = document.createElement("canvas");
        this._tmpCtx = this._tmpCanvas.getContext("2d");
    }
    apply(target, reltime) {
        if (target.canvas.width !== this._tmpCanvas.width) this._tmpCanvas.width = target.canvas.width;
        if (target.canvas.height !== this._tmpCanvas.height) this._tmpCanvas.height = target.canvas.height;
        const radius = val(this.radius, target, reltime);
        if (radius % 2 !== 1 || radius <= 0) throw "Radius should be an odd natural number";

        let imageData = target.cctx.getImageData(0, 0, target.canvas.width, target.canvas.height);
        let tmpImageData = this._tmpCtx.getImageData(0, 0, this._tmpCanvas.width, this._tmpCanvas.height);
        // only one dimension (either x or y) of the kernel
        let kernel = gen1DKernel(Math.round(radius));
        let kernelStart = -(radius-1) / 2, kernelEnd = -kernelStart;
        // vertical pass
        for (let x=0; x<this._tmpCanvas.width; x++) {
            for (let y=0; y<this._tmpCanvas.height; y++) {
                let r=0, g=0, b=0, a=imageData.data[4*(this._tmpCanvas.width*y+x)+3];
                // apply kernel
                for (let kernelY=kernelStart; kernelY<=kernelEnd; kernelY++) {
                    if (y+kernelY >= this._tmpCanvas.height) break;
                    let kernelIndex = kernelY - kernelStart; // actual array index (not y-coordinate)
                    let weight = kernel[kernelIndex];
                    let ki = 4*(this._tmpCanvas.width*(y+kernelY)+x);
                    r += weight * imageData.data[ki + 0];
                    g += weight * imageData.data[ki + 1];
                    b += weight * imageData.data[ki + 2];
                }
                let i = 4*(this._tmpCanvas.width*y+x);
                tmpImageData.data[i + 0] = r;
                tmpImageData.data[i + 1] = g;
                tmpImageData.data[i + 2] = b;
                tmpImageData.data[i + 3] = a;
            }
        }
        imageData = tmpImageData;   // pipe the previous ouput to the input of the following code
        tmpImageData = this._tmpCtx.getImageData(0, 0, this._tmpCanvas.width, this._tmpCanvas.height);    // create new output space
        // horizontal pass
        for (let y=0; y<this._tmpCanvas.height; y++) {
            for (let x=0; x<this._tmpCanvas.width; x++) {
                let r=0, g=0, b=0, a=imageData.data[4*(this._tmpCanvas.width*y+x)+3];
                // apply kernel
                for (let kernelX=kernelStart; kernelX<=kernelEnd; kernelX++) {
                    if (x+kernelX >= this._tmpCanvas.width) break;
                    let kernelIndex = kernelX - kernelStart; // actual array index (not y-coordinate)
                    let weight = kernel[kernelIndex];
                    let ki = 4 * (this._tmpCanvas.width*y+(x+kernelX));
                    r += weight * imageData.data[ki + 0];
                    g += weight * imageData.data[ki + 1];
                    b += weight * imageData.data[ki + 2];
                }
                let i = 4*(this._tmpCanvas.width*y+x);
                tmpImageData.data[i + 0] = r;
                tmpImageData.data[i + 1] = g;
                tmpImageData.data[i + 2] = b;
                tmpImageData.data[i + 3] = a;
            }
        }
        target.cctx.putImageData(tmpImageData, 0, 0);
    }
}
function gen1DKernel(radius) {
    let pascal = genPascalRow(radius);
    // don't use `reduce` and `map` (overhead?)
    let sum = 0;
    for (let i=0; i<pascal.length; i++)
        sum += pascal[i];
    for (let i=0; i<pascal.length; i++)
        pascal[i] /= sum;
    return pascal;
}
function genPascalRow(index) {
    if (index < 0) throw `Invalid index ${index}`;
    let currRow = [1];
    for (let i=1; i<index; i++) {
        let nextRow = [];
        nextRow.length = currRow.length + 1;
        // edges are always 1's
        nextRow[0] = nextRow[nextRow.length-1] = 1;
        for (let j=1; j<nextRow.length-1; j++)
            nextRow[j] = currRow[j-1] + currRow[j];
        currRow = nextRow;
    }
    return currRow;
}

/** Makes the target look pixelated (have large "pixels") */
export class Pixelate extends Base {
    /**
     * @param {boolean} [options.ignorePixelHeight=false] - whether to make pixels square and use pixelWidth
     *  as the dimension
     */
    constructor(pixelWidth=1, pixelHeight=1, options={}) {
        super();
        this.pixelWidth = pixelWidth;
        this.pixelHeight = pixelHeight;
        this.ignorePixelHeight = options.ignorePixelHeight || false;

        // not needed because you can read and write to the same canvas with this effect, I'm pretty sure
        // this._tmpCanvas = document.createElement("canvas");
        // this._tmpCtx = this._tmpCanvas.getContext("2d");
    }

    apply(target, reltime) {
        const pw = val(this.pixelWidth, target, reltime),
            ph = !val(this.ignorePixelHeight, target, reltime) ? val(this.pixelHeight, target, reltime) : pw;
        // if (target.canvas.width !== this._tmpCanvas.width) this._tmpCanvas.width = target.canvas.width;
        // if (target.canvas.height !== this._tmpCanvas.height) this._tmpCanvas.height = target.canvas.height;

        if (pw % 1 !== 0 || ph % 1 !== 0 || pw < 0 || ph < 0)
            throw "Pixel dimensions must be whole numbers";

        const imageData = target.cctx.getImageData(0, 0, target.canvas.width, target.canvas.height);

        // use the average of each small pixel in the new pixel for the value of the new pixel
        for (let y=0; y<target.canvas.height; y += ph) {
            for (let x=0; x<target.canvas.width; x += pw) {
                let r=0, g=0, b=0, count=0;
                // for (let sy=0; sy<ph; sy++) {
                //     for (let sx=0; sx<pw; sx++) {
                //         let i = 4*(target.canvas.width*(y+sy)+(x+sx));
                //         r += imageData.data[i+0];
                //         g += imageData.data[i+1];
                //         b += imageData.data[i+2];
                //         count++;
                //     }
                // }
                // r /= count;
                // g /= count;
                // b /= count;
                let i = 4*(target.canvas.width*(y+Math.floor(ph/2))+(x+Math.floor(pw/2)));
                r = imageData[i+0];
                g = imageData[i+1];
                b = imageData[i+2];

                // apply average color
                // this._tmpCtx.fillColor = `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
                // this._tmpCtx.fillRect(x, y, pw, ph); // fill new (large) pixel
                target.cctx.fillStyle = `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
                target.cctx.fillRect(x, y, pw, ph); // fill new (large) pixel
            }
        }
    }
}

// TODO: implement directional blur
// TODO: implement radial blur
// TODO: implement zoom blur

/* DISTORTION */
/**
 * Transforms a layer or movie using a transformation matrix. Use {@link Transform.Matrix}
 * to either A) calculate those values based on a series of translations, scalings and rotations)
 * or B) input the matrix values directly, using the optional argument in the constructor.
 */
export class Transform {
    /**
     * @param {Transform.Matrix} matrix - how to transform the target
     */
    constructor(matrix) {
        this.matrix = matrix;
        this._tmpMatrix = new Transform.Matrix();
        this._tmpCanvas = document.createElement("canvas");
        this._tmpCtx = this._tmpCanvas.getContext("2d");
    }

    apply(target, reltime) {
        if (target.canvas.width !== this._tmpCanvas.width) this._tmpCanvas.width = target.canvas.width;
        if (target.canvas.height !== this._tmpCanvas.height) this._tmpCanvas.height = target.canvas.height;
        this._tmpMatrix.data = val(this.matrix.data, target, reltime); // use data, since that's the underlying storage

        this._tmpCtx.setTransform(
            this._tmpMatrix.a, this._tmpMatrix.b, this._tmpMatrix.c,
            this._tmpMatrix.d, this._tmpMatrix.e, this._tmpMatrix.f
        );
        this._tmpCtx.drawImage(target.canvas, 0, 0);
        // Assume it was identity for now
        this._tmpCtx.setTransform(1, 0, 0, 0, 1, 0, 0, 0, 1);
        target.cctx.clearRect(0, 0, target.canvas.width, target.canvas.height);
        target.cctx.drawImage(this._tmpCanvas, 0, 0);
    }
}
/** @class
 * A 3x3 matrix for storing 2d transformations
 */
Transform.Matrix = class Matrix {
    constructor(data) {
        this.data = data || [
            1, 0, 0,
            0, 1, 0,
            0, 0, 1
        ];
    }

    identity() {
        for (let i=0; i<this.data.length; i++)
            this.data[i] = Transform.Matrix.IDENTITY.data[i];

        return this;
    }

    /**
     * @param {number} x
     * @param {number} y
     * @param {number} [val]
     */
    cell(x, y, val) {
        if (val !== undefined) this.data[3*y + x] = val;
        return this.data[3*y + x];
    }

    /* For canvas context setTransform */
    get a() { return this.data[0]; }
    get b() { return this.data[3]; }
    get c() { return this.data[1]; }
    get d() { return this.data[4]; }
    get e() { return this.data[2]; }
    get f() { return this.data[5]; }

    /** Combines <code>this</code> with another matrix <code>other</code> */
    multiply(other) {
        // copy to temporary matrix to avoid modifying `this` while reading from it
        // http://www.informit.com/articles/article.aspx?p=98117&seqNum=4
        for (let x=0; x<3; x++) {
            for (let y=0; y<3; y++) {
                let sum = 0;
                for (let i=0; i<3; i++)
                    sum += this.cell(x, i) * other.cell(i, y);
                TMP_MATRIX.cell(x, y, sum);
            }
        }
        // copy data from TMP_MATRIX to this
        for (let i=0; i<TMP_MATRIX.data.length; i++)
            this.data[i] = TMP_MATRIX.data[i];
        return this;
    }

    translate(x, y) {
        this.multiply(new Transform.Matrix([
            1, 0, x,
            0, 1, y,
            0, 0, 1
        ]));

        return this;
    }

    scale(x, y) {
        this.multiply(new Transform.Matrix([
            x, 0, 0,
            0, y, 0,
            0, 0, 1
        ]));

        return this;
    }

    /**
     * @param {number} a - the angle or rotation in radians
     */
    rotate(a) {
        let c = Math.cos(a), s = Math.sin(a);
        this.multiply(new Transform.Matrix([
            c, s, 0,
           -s, c, 0,
            0, 0, 1
        ]));

        return this;
    }
};
Transform.Matrix.IDENTITY = new Transform.Matrix();
const TMP_MATRIX = new Transform.Matrix();

// TODO: layer masks will make much more complex masks possible
/** Preserves an ellipse of the layer and clears the rest */
export class EllipticalMask extends Base {
    constructor(x, y, radiusX, radiusY, rotation=0, startAngle=0, endAngle=2*Math.PI, anticlockwise=false) {
        super();
        this.x = x;
        this.y = y;
        this.radiusX = radiusX;
        this.radiusY = radiusY;
        this.rotation = rotation;
        this.startAngle = startAngle;
        this.endAngle = endAngle;
        this.anticlockwise = anticlockwise;
        // for saving image data before clearing
        this._tmpCanvas = document.createElement("canvas");
        this._tmpCtx = this._tmpCanvas.getContext("2d");
    }
    apply(target, reltime) {
        const ctx = target.cctx, canvas = target.canvas;
        const x = val(this.x, target, reltime), y = val(this.y, target, reltime),
            radiusX = val(this.radiusX, target, reltime), radiusY = val(this.radiusY, target, reltime),
            rotation = val(this.rotation, target, reltime),
            startAngle = val(this.startAngle, target, reltime), endAngle = val(this.endAngle, target, reltime),
            anticlockwise = val(this.anticlockwise, target, reltime);
        this._tmpCanvas.width = target.canvas.width;
        this._tmpCanvas.height = target.canvas.height;
        this._tmpCtx.drawImage(canvas, 0, 0);

        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();  // idk how to preserve clipping state without save/restore
        // create elliptical path and clip
        ctx.beginPath();
        ctx.ellipse(x, y, radiusX, radiusY, rotation, startAngle, endAngle, anticlockwise);
        ctx.closePath();
        ctx.clip();
        // render image with clipping state
        ctx.drawImage(this._tmpCanvas, 0, 0);
        ctx.restore();
    }
}
