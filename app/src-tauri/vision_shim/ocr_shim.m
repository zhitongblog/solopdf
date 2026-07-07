// Vision-framework OCR shim for SoloPDF (macOS 14+ / iOS 14+).
// C ABI so Rust can call it without objc runtime bindings.
// Returns a malloc'd UTF-8 JSON array:
//   [{"t":"text","c":0.97,"x":0.1,"y":0.2,"w":0.5,"h":0.04}, ...]
// Coordinates are normalized to the image with a TOP-LEFT origin
// (Vision reports bottom-left; we flip here so every consumer is uniform).
// On failure returns {"error":"..."} — still a malloc'd string.

#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <ImageIO/ImageIO.h>

static char *json_copy(NSObject *obj) {
    NSError *err = nil;
    NSData *data = [NSJSONSerialization dataWithJSONObject:obj options:0 error:&err];
    if (!data) return strdup("{\"error\":\"json encode failed\"}");
    char *out = malloc(data.length + 1);
    memcpy(out, data.bytes, data.length);
    out[data.length] = 0;
    return out;
}

static char *error_json(NSString *msg) {
    return json_copy(@{ @"error" : (msg ?: @"unknown") });
}

char *solopdf_vision_ocr(const uint8_t *bytes, size_t len, const char *langs_csv) {
    @autoreleasepool {
        if (!bytes || len == 0) return error_json(@"empty image");
        NSData *data = [NSData dataWithBytesNoCopy:(void *)bytes length:len freeWhenDone:NO];
        CGImageSourceRef src = CGImageSourceCreateWithData((__bridge CFDataRef)data, NULL);
        if (!src) return error_json(@"cannot decode image");
        CGImageRef img = CGImageSourceCreateImageAtIndex(src, 0, NULL);
        CFRelease(src);
        if (!img) return error_json(@"cannot decode image frame");

        VNRecognizeTextRequest *req = [[VNRecognizeTextRequest alloc] init];
        req.recognitionLevel = VNRequestTextRecognitionLevelAccurate;
        req.usesLanguageCorrection = YES;
        // runtime check instead of @available: cargo links with -nodefaultlibs,
        // and @available needs compiler-rt's __isPlatformVersionAtLeast
        if ([req respondsToSelector:@selector(setAutomaticallyDetectsLanguage:)]) {
            req.automaticallyDetectsLanguage = YES; // macOS 13+ / iOS 16+
        }
        NSMutableArray<NSString *> *langs = [NSMutableArray array];
        if (langs_csv && *langs_csv) {
            for (NSString *l in [[NSString stringWithUTF8String:langs_csv]
                     componentsSeparatedByString:@","]) {
                NSString *t = [l stringByTrimmingCharactersInSet:
                                     [NSCharacterSet whitespaceCharacterSet]];
                if (t.length) [langs addObject:t];
            }
        }
        if (langs.count) req.recognitionLanguages = langs;

        VNImageRequestHandler *handler =
            [[VNImageRequestHandler alloc] initWithCGImage:img options:@{}];
        NSError *err = nil;
        BOOL ok = [handler performRequests:@[ req ] error:&err];
        CGImageRelease(img);
        if (!ok) return error_json(err.localizedDescription);

        NSMutableArray *lines = [NSMutableArray array];
        for (VNRecognizedTextObservation *obs in req.results) {
            VNRecognizedText *best = [obs topCandidates:1].firstObject;
            if (!best || best.string.length == 0) continue;
            CGRect b = obs.boundingBox; // normalized, bottom-left origin
            [lines addObject:@{
                @"t" : best.string,
                @"c" : @(best.confidence),
                @"x" : @(b.origin.x),
                @"y" : @(1.0 - b.origin.y - b.size.height), // flip to top-left
                @"w" : @(b.size.width),
                @"h" : @(b.size.height),
            }];
        }
        return json_copy(lines);
    }
}

void solopdf_ocr_free(char *p) {
    if (p) free(p);
}
