package comments

import (
	"bytes"
	"mime/multipart"
)

func newMultipartWriter(target *bytes.Buffer, filename string, data []byte) string {
	writer := multipart.NewWriter(target)
	part, _ := writer.CreateFormFile("file", filename)
	_, _ = part.Write(data)
	_ = writer.Close()
	return writer.FormDataContentType()
}
